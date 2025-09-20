import azure.functions as func
import firebase_admin
from json import dumps, loads
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
from openai import AzureOpenAI
import hashlib
import time

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeploymentMini").value
client = AzureOpenAI(
    api_version="2023-07-01-preview", azure_endpoint=endpoint, api_key=api_key
)

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()


def _safe_int(x, default=0):
    try:
        return int(x)
    except Exception:
        return default


def _task_key(title: str, description: str, category: str, complexity: int) -> str:
    base = f"{(title or '').strip().lower()}|{(category or '').strip().lower()}|{_safe_int(complexity, 3)}|{(description or '').strip().lower()}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def _skills_key(skills: list[dict]) -> str:
    # Normalize skills list into deterministic string then hash
    norm = []
    for s in skills or []:
        nm = str((s or {}).get("skill") or "").strip().lower()
        lvl = _safe_int((s or {}).get("level"), 5)
        norm.append((nm, lvl))
    norm.sort(key=lambda x: (x[0], x[1]))
    blob = ";".join([f"{n}:{l}" for n, l in norm])
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def _base_hours(complexity: int) -> int:
    cx = max(1, min(5, _safe_int(complexity, 3)))
    return 6 + 8 * cx


def _compose_prompt(task: dict, assignee: dict) -> tuple[str, str]:
    system = (
        "You estimate effort multipliers for tasks given an assignee's skills. "
        "Respond ONLY as strict JSON: {\"multiplier\": number, \"reason\": string}. "
        "'multiplier' must be between 0.6 and 1.4 inclusive. "
        "Interpret higher skill alignment as lower multiplier."
    )
    user = dumps(
        {
            "task": {
                "title": task.get("title", ""),
                "description": task.get("description", ""),
                "category": task.get("category", ""),
                "complexity": max(1, min(5, _safe_int(task.get("complexity"), 3))),
            },
            "assignee": {
                "title": assignee.get("title", ""),
                "skills": [
                    {"skill": s.get("skill"), "level": _safe_int(s.get("level"), 5)}
                    for s in (assignee.get("skills") or [])
                ][:8],
            },
            "return": {
                "multiplier": "float in [0.6,1.4]",
                "reason": "short string",
            },
        }
    )
    return system, user


def _call_llm(task: dict, assignee: dict) -> tuple[float, str]:
    sys, usr = _compose_prompt(task, assignee)
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": usr}],
        timeout=15,
    )
    try:
        data = loads(rsp.choices[0].message.content)
        mult = float(data.get("multiplier"))
        # Clamp multiplier to safe range
        mult = max(0.6, min(1.4, mult))
        reason = str(data.get("reason", ""))
        return mult, reason
    except Exception:
        # Fallback neutral multiplier
        return 1.0, "fallback"


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        return func.HttpResponse(dumps({"error": "invalid json"}), status_code=400)

    company = (body or {}).get("company")
    workitem_id = (body or {}).get("workitem_id")
    if not company or not workitem_id:
        return func.HttpResponse(dumps({"error": "missing fields"}), status_code=400)

    company_ref = db.collection("companies").document(company)
    wi_ref = company_ref.collection("workitems").document(str(workitem_id))
    wi_snap = wi_ref.get()
    if not wi_snap.exists:
        return func.HttpResponse(dumps({"error": "workitem not found"}), status_code=404)
    wi = wi_snap.to_dict() or {}

    status = str(wi.get("status") or "").lower()
    if status not in ("doing", "in_progress"):
        return func.HttpResponse(dumps({"ok": True, "skipped": True, "reason": "not doing"}), mimetype="application/json")

    assignee_id = str(wi.get("assignee_id") or "")
    if not assignee_id:
        return func.HttpResponse(dumps({"ok": True, "skipped": True, "reason": "no assignee"}), mimetype="application/json")

    emp_ref = company_ref.collection("employees").document(assignee_id)
    emp_snap = emp_ref.get()
    if not emp_snap.exists:
        return func.HttpResponse(dumps({"error": "assignee not found"}), status_code=404)
    emp = emp_snap.to_dict() or {}
    # Load skills
    skills = [d.to_dict() for d in emp_ref.collection("skills").stream()]
    for s in skills:
        s.pop("updated", None)
    emp["skills"] = skills

    # Cache lookup: employees/{id}/rates/{workitem_id}
    rates_ref = emp_ref.collection("rates").document(str(workitem_id))
    cached = rates_ref.get()

    base_hours = _base_hours(_safe_int(wi.get("complexity"), 3))
    used_cache = False
    mult = 1.0
    reason = ""
    est_hours = _safe_int(wi.get("estimated_hours") or base_hours, base_hours)

    if cached.exists:
        c = cached.to_dict() or {}
        mult = float(c.get("multiplier") or 1.0)
        est_hours = _safe_int(c.get("estimated_hours") or base_hours, base_hours)
        used_cache = True
    else:
        # Call LLM for a multiplier
        mult, reason = _call_llm(
            {
                "title": wi.get("title", ""),
                "description": wi.get("description", ""),
                "category": wi.get("category", ""),
                "complexity": _safe_int(wi.get("complexity"), 3),
            },
            {
                "title": emp.get("title", ""),
                "skills": skills,
            },
        )
        est_hours = int(round(max(1, base_hours * mult)))
        # Store cache entry
        try:
            rates_ref.set(
                {
                    "workitem_id": str(workitem_id),
                    "task_title": wi.get("title", ""),
                    "task_category": wi.get("category", ""),
                    "complexity": _safe_int(wi.get("complexity"), 3),
                    "base_hours": base_hours,
                    "multiplier": mult,
                    "estimated_hours": est_hours,
                    "task_key": _task_key(wi.get("title", ""), wi.get("description", ""), wi.get("category", ""), _safe_int(wi.get("complexity"), 3)),
                    "skills_key": _skills_key(skills),
                    "model": deployment,
                    "reason": reason,
                    "created": firestore.SERVER_TIMESTAMP,
                    "updated": firestore.SERVER_TIMESTAMP,
                }
            )
        except Exception:
            pass

    # Update work item with new estimate if changed
    try:
        wi_update = {
            "estimated_hours": est_hours,
            "rate_per_hour": round(100.0 / max(1, est_hours), 4),
            "estimate_source": "llm" if not used_cache else "llm_cache",
            "updated": firestore.SERVER_TIMESTAMP,
        }
        wi_ref.update(wi_update)
    except Exception:
        pass

    return func.HttpResponse(
        dumps({
            "ok": True,
            "used_cache": used_cache,
            "estimated_hours": est_hours,
            "base_hours": base_hours,
            "multiplier": mult,
        }),
        mimetype="application/json",
    )

