import azure.functions as func
import firebase_admin
from json import dumps, loads
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
from openai import AzureOpenAI
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


def pull_context(company):
    company_ref = db.collection("companies").document(company)
    c = company_ref.get().to_dict() or {}
    products = (
        company_ref.collection("products").where("accepted", "==", True).get()
    )
    product = None
    for p in products:
        product = p.to_dict() | {"id": p.id}
        break
    employees = []
    for d in (
        company_ref.collection("employees").where("hired", "==", True).stream()
    ):
        emp_raw = d.to_dict() | {"id": d.id}
        for k in ["created", "updated", "hired"]:
            if k in emp_raw:
                try:
                    emp_raw.pop(k)
                except Exception:
                    pass
        skills = []
        for s in d.reference.collection("skills").stream():
            sd = s.to_dict() or {}
            if "updated" in sd:
                try:
                    sd.pop("updated")
                except Exception:
                    pass
            skills.append({
                "skill": sd.get("skill"),
                "level": sd.get("level", 5),
            })
        emp_raw["skills"] = skills
        employees.append(emp_raw)
    return {
        "company": c,
        "product": product,
        "employees": employees,
    }


def llm_plan(ctx):
    company_name = ctx.get("company", {}).get("company_name", "")
    company_description = ctx.get("company", {}).get("description", "")
    funding = (ctx.get("company", {}) or {}).get("funding", {})
    approved = bool(funding.get("approved", False))
    amount = float(funding.get("amount", 0) or 0)
    grace = int(funding.get("grace_period_days", 0) or 0)
    first_payment = float(funding.get("first_payment", 0) or 0)
    product_name = (ctx.get("product") or {}).get("product", "")
    product_description = (ctx.get("product") or {}).get("description", "")
    employees = ctx.get("employees", [])
    sys = (
        "Create a comprehensive set of work items to deliver the proposed MVP end-to-end. "
        "Return strict JSON with key 'workitems' as a list. Each item must have: "
        "title, description, assignee_name, category, complexity. "
        "complexity is an integer 1-5 (1=trivial, 5=hard). "
        "Use employees' names and titles to assign appropriately, matching skills and seniority. "
        "Cover cross-functional needs (engineering, design, product, data, infra, QA, marketing, launch). "
        "Aim for a complete plan rather than a starter list. Return between 15 and 40 items based on scope and team size. "
        "If funding or loan details are provided, explicitly include early revenue-generation work (pricing, payments, onboarding, billing, go-to-market) so the company can make money quickly and cover bank payments on time. "
        "Keep titles concise and descriptions actionable. No commentary outside the JSON."
    )
    user = dumps(
        {
            "company_name": company_name,
            "company_description": company_description,
            "funding": {
                "approved": approved,
                "amount": amount,
                "grace_period_days": grace,
                "first_payment": first_payment,
            },
            "product_name": product_name,
            "product_description": product_description,
            "employees": [
                {
                    "name": e.get("name"),
                    "title": e.get("title"),
                    "skills": [
                        {"skill": (s or {}).get("skill"), "level": (s or {}).get("level", 5)}
                        for s in (e.get("skills", []) or [])
                    ],
                }
                for e in employees
            ],
        }
    )
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
    )
    try:
        data = loads(rsp.choices[0].message.content)
        items = data.get("workitems") or []
        if isinstance(items, list):
            return items
        return []
    except Exception:
        return []


def level_avg(emp):
    lvls = [max(1, min(10, int(s.get("level", 5)))) for s in emp.get("skills", [])]
    if not lvls:
        return 5
    return sum(lvls) / len(lvls)


def estimate_hours(complexity, emp_level):
    base = 6 + 8 * max(1, min(5, int(complexity)))
    mult = 1.0 - (emp_level - 5) * 0.05
    mult = max(0.6, min(1.4, mult))
    return int(round(base * mult))


def ensure_items(company, ctx, items, start_at):
    if not items:
        emps = ctx.get("employees", [])
        fallback = []
        for e in emps:
            title = (e.get("title") or "").lower()
            if "engineer" in title or "developer" in title:
                fallback.append(
                    {
                        "title": "Set up project repo",
                        "description": "Initialize repository, CI, and environments",
                        "assignee_name": e.get("name"),
                        "category": "Engineering",
                        "complexity": 2,
                    }
                )
                fallback.append(
                    {
                        "title": "Implement core feature",
                        "description": "Deliver the first user-facing capability",
                        "assignee_name": e.get("name"),
                        "category": "Engineering",
                        "complexity": 4,
                    }
                )
            elif "design" in title:
                fallback.append(
                    {
                        "title": "Wireframes",
                        "description": "Create wireframes for primary flows",
                        "assignee_name": e.get("name"),
                        "category": "Design",
                        "complexity": 3,
                    }
                )
            elif "product" in title:
                fallback.append(
                    {
                        "title": "MVP spec",
                        "description": "Define MVP scope and acceptance criteria",
                        "assignee_name": e.get("name"),
                        "category": "Product",
                        "complexity": 2,
                    }
                )
            elif "marketing" in title or "growth" in title:
                fallback.append(
                    {
                        "title": "Launch plan",
                        "description": "Draft channels, messaging, and KPIs",
                        "assignee_name": e.get("name"),
                        "category": "Marketing",
                        "complexity": 3,
                    }
                )
        items = fallback
    company_ref = db.collection("companies").document(company)
    work_ref = company_ref.collection("workitems")
    emps_by_name = {e.get("name"): e for e in ctx.get("employees", [])}
    normalized = []
    for wi in items:
        t = str(wi.get("title", ""))
        d = str(wi.get("description", ""))
        cat = str(wi.get("category", ""))
        cx = max(1, min(5, int(wi.get("complexity", 3))))
        nm = str(wi.get("assignee_name", "")).strip()
        emp = emps_by_name.get(nm) or {}
        if not emp:
            nm = ""
        normalized.append({
            "title": t,
            "description": d,
            "category": cat,
            "complexity": cx,
            "assignee_name": nm,
        })
    def reserve_tids(n):
        tr = db.transaction()
        @firestore.transactional
        def txn(transaction, n):
            snap = company_ref.get(transaction=transaction)
            data = snap.to_dict() or {}
            start = int(data.get("work_next_tid") or 1)
            transaction.set(company_ref, {"work_next_tid": start + n}, merge=True)
            return start
        return txn(tr, n)
    start_tid = reserve_tids(len(normalized)) if normalized else 0
    doc_ids = [str(start_tid + i) for i in range(len(normalized))]
    def rank(cat: str) -> int:
        c = (cat or "").lower()
        if "product" in c:
            return 0
        if "design" in c:
            return 1
        if any(k in c for k in ["engineer", "eng", "dev", "frontend", "backend", "data", "infra", "ops", "platform", "security"]):
            return 2
        if any(k in c for k in ["qa", "test"]):
            return 3
        if any(k in c for k in ["marketing", "growth", "sales"]):
            return 4
        if any(k in c for k in ["launch", "release"]):
            return 5
        return 2
    blockers_by_idx = {}
    for j, wj in enumerate(normalized):
        rj = rank(wj.get("category", ""))
        blockers = []
        for i in range(j):
            wi = normalized[i]
            ri = rank(wi.get("category", ""))
            if ri < rj:
                blockers.append(doc_ids[i])
            if len(blockers) >= 3:
                break
        blockers_by_idx[j] = blockers
    for idx, wi in enumerate(normalized):
        assignee_name = wi.get("assignee_name", "")
        emp = emps_by_name.get(assignee_name) or {}
        emp_id = emp.get("id", "")
        emp_level = level_avg(emp)
        cx = int(wi.get("complexity", 3))
        est = estimate_hours(cx, emp_level)
        tid = start_tid + idx
        doc_id = str(tid)
        work_ref.document(str(doc_id)).set(
            {
                "tid": tid,
                "title": wi.get("title", ""),
                "description": wi.get("description", ""),
                "assignee_id": emp_id,
                "assignee_name": assignee_name,
                "assignee_title": emp.get("title", ""),
                "category": wi.get("category", ""),
                "complexity": cx,
                "estimated_hours": est,
                "rate_per_hour": round(100.0 / max(1, est), 4),
                "status": "todo",
                "work_start_hour": 10,
                "work_end_hour": 20,
                "blockers": blockers_by_idx.get(idx, []),
                "created": firestore.SERVER_TIMESTAMP,
                "updated": firestore.SERVER_TIMESTAMP,
            }
        )
    company_ref.set({"work_enabled": True, "work_created_at": firestore.SERVER_TIMESTAMP}, merge=True)


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        return func.HttpResponse(dumps({"error": "invalid json"}), status_code=400)
    company = body.get("company")
    if not company:
        return func.HttpResponse(dumps({"error": "missing company"}), status_code=400)
    ctx = pull_context(company)
    if not ctx.get("product"):
        return func.HttpResponse(dumps({"error": "no accepted product"}), status_code=400)
    cdoc = db.collection("companies").document(company).get().to_dict() or {}
    start_at = int(cdoc.get("simTime") or int(time.time() * 1000))
    existing = (
        db.collection("companies")
        .document(company)
        .collection("workitems")
        .limit(1)
        .get()
    )
    if existing:
        try:
            if len(existing) > 0:
                return func.HttpResponse(dumps({"ok": True, "skipped": True}), mimetype="application/json")
        except Exception:
            pass
    planned = llm_plan(ctx)
    ensure_items(company, ctx, planned, start_at)
    return func.HttpResponse(dumps({"ok": True}), mimetype="application/json")
