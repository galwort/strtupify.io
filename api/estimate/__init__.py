import logging
import math
from json import dumps, loads
from typing import Any, Dict, List, Tuple

import azure.functions as func
import firebase_admin
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, firestore, initialize_app
from openai import OpenAI
from pydantic import BaseModel, ConfigDict

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value.rstrip("/")
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeploymentMini").value
API_VERSION = "2024-08-01-preview"
client = OpenAI(
    api_key=api_key,
    base_url=f"{endpoint}/openai/v1/",
)

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()

logger = logging.getLogger("estimate_llm_rates")

MAX_EMPLOYEES = 25
MAX_SKILLS_PER_EMPLOYEE = 12
MAX_WORKITEMS = 60
MIN_RATE = 0.1
MAX_RATE = 5.0


class RateCell(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    rate: float


class WorkItemRates(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workitem_id: str
    employees: List[RateCell]


class RateAssignments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignments: List[WorkItemRates]


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _clamp_rate(value: Any) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return MIN_RATE
    if not math.isfinite(num):
        return MIN_RATE
    return max(MIN_RATE, min(MAX_RATE, num))


def _hours_from_rate(rate: float) -> int:
    pct = max(MIN_RATE, min(MAX_RATE, rate))
    return max(1, int(round(100.0 / pct)))


def _load_employees(
    company_ref,
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    employees: Dict[str, Dict[str, Any]] = {}
    ordered: List[Dict[str, Any]] = []
    try:
        cursor = company_ref.collection("employees").where("hired", "==", True).stream()
    except Exception:
        cursor = []
    for snap in cursor:
        data = snap.to_dict() or {}
        emp_id = snap.id
        emp_ref = company_ref.collection("employees").document(emp_id)
        skills: List[Dict[str, Any]] = []
        try:
            for skill_snap in emp_ref.collection("skills").stream():
                sk = skill_snap.to_dict() or {}
                title = str(sk.get("skill") or "").strip()
                if not title:
                    continue
                lvl_raw = sk.get("level", 5)
                try:
                    lvl = int(lvl_raw)
                except (TypeError, ValueError):
                    lvl = 5
                lvl = max(1, min(10, lvl))
                skills.append({"skill": title, "level": lvl})
                if len(skills) >= MAX_SKILLS_PER_EMPLOYEE:
                    break
        except Exception as exc:
            logger.debug("failed to load skills for %s: %s", emp_id, exc)
        if not skills:
            skills.append({"skill": "generalist", "level": 5})
        emp_doc = {
            "id": emp_id,
            "name": str(data.get("name") or "").strip(),
            "title": str(data.get("title") or "").strip(),
            "skills": skills,
        }
        employees[emp_id] = emp_doc
        ordered.append(emp_doc)
        if len(ordered) >= MAX_EMPLOYEES:
            break
    return employees, ordered


def _load_workitems(company_ref, include_done: bool = False) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    try:
        cursor = company_ref.collection("workitems").stream()
    except Exception:
        cursor = []
    for snap in cursor:
        data = snap.to_dict() or {}
        status = str(data.get("status") or "").strip().lower()
        if not include_done and status == "done":
            continue
        itm = {
            "id": snap.id,
            "title": str(data.get("title") or ""),
            "description": str(data.get("description") or ""),
            "category": str(data.get("category") or ""),
            "complexity": _safe_int(data.get("complexity"), 3),
            "status": status,
            "assignee_id": str(data.get("assignee_id") or ""),
        }
        items.append(itm)
        if len(items) >= MAX_WORKITEMS:
            break
    return items


def _build_llm_payload(
    employees: List[Dict[str, Any]], workitems: List[Dict[str, Any]]
) -> Dict[str, Any]:
    return {
        "employees": [
            {
                "id": emp["id"],
                "title": emp["title"],
                "skills": emp["skills"],
            }
            for emp in employees
        ],
        "workitems": [
            {
                "id": itm["id"],
                "title": itm["title"],
                "description": itm["description"],
                "category": itm["category"],
                "complexity": max(1, min(5, _safe_int(itm.get("complexity"), 3))),
            }
            for itm in workitems
        ],
        "instructions": (
            "For every work item, return an object with workitem_id and a list named employees. "
            "Each employees entry has employee_id and rate. "
            "Rate must be between 0.1 and 5.0."
        ),
        "rate_scale": "percentage of work completed per simulated hour",
    }


def _call_llm(payload: Dict[str, Any]) -> Dict[str, Dict[str, float]]:
    if not payload["employees"] or not payload["workitems"]:
        return {}
    system = (
        "You are an expert workforce planner. "
        "Return only JSON that conforms to the schema. "
        f"Rates must be between {MIN_RATE} and {MAX_RATE}. "
        "For each work item include workitem_id and an employees array of objects with employee_id and rate."
    )
    user = dumps(payload)
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
        top_p=0.9,
        max_tokens=2048,
        response_format=RateAssignments,
    )
    parsed = completion.choices[0].message.parsed
    assignments_list = parsed.assignments if isinstance(parsed, RateAssignments) else []
    mapped: Dict[str, Dict[str, float]] = {}
    for row in assignments_list:
        emp_map: Dict[str, float] = {}
        for cell in row.employees:
            emp_map[cell.employee_id] = cell.rate
        mapped[row.workitem_id] = emp_map
    return {
        wid: {eid: _clamp_rate(rate) for eid, rate in (emps or {}).items()}
        for wid, emps in mapped.items()
    }


def _fallback_assignments(
    workitems: List[Dict[str, Any]], employees: Dict[str, Dict[str, Any]]
) -> Dict[str, Dict[str, float]]:
    if not employees or not workitems:
        return {}
    default_rate = 1.0
    return {
        wi["id"]: {emp_id: default_rate for emp_id in employees.keys()}
        for wi in workitems
    }


def _apply_assignments(
    company_ref,
    workitems: List[Dict[str, Any]],
    employees: Dict[str, Dict[str, Any]],
    assignments: Dict[str, Dict[str, float]],
) -> List[Dict[str, Any]]:
    summaries: List[Dict[str, Any]] = []
    for wi in workitems:
        work_id = wi["id"]
        rates = assignments.get(work_id)
        if not rates:
            continue
        normalized = {
            emp_id: _clamp_rate(rate)
            for emp_id, rate in rates.items()
            if emp_id in employees
        }
        if not normalized:
            continue
        best_emp, best_rate = max(normalized.items(), key=lambda pair: pair[1])
        est_hours = _hours_from_rate(best_rate)
        work_ref = company_ref.collection("workitems").document(work_id)
        update_doc: Dict[str, Any] = {
            "rate_source": "llm_structured",
            "rate_per_hour": round(best_rate, 4),
            "estimated_hours": est_hours,
            "updated": firestore.SERVER_TIMESTAMP,
            "llm_rates.rates": normalized,
            "llm_rates.assigned_employee_id": best_emp,
            "llm_rates.assigned_rate": round(best_rate, 4),
            "llm_rates.rate_units": "percent_per_hour",
            "llm_rates.model": deployment,
            "llm_rates.generated": firestore.SERVER_TIMESTAMP,
            "llm_rates.updated": firestore.SERVER_TIMESTAMP,
        }
        if wi.get("status") != "done":
            update_doc.update(
                {
                    "assignee_id": best_emp,
                }
            )
        try:
            work_ref.update(update_doc)
        except Exception as exc:
            logger.debug("failed to update work item %s: %s", work_id, exc)
        summaries.append(
            {
                "workitem_id": work_id,
                "assigned_employee_id": best_emp,
                "rate": round(best_rate, 4),
                "estimated_hours": est_hours,
            }
        )
    return summaries


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        body = {}
    company_id = str((body or {}).get("company") or "").strip()
    if not company_id:
        return func.HttpResponse(
            dumps({"error": "missing company"}),
            status_code=400,
            mimetype="application/json",
        )
    company_ref = db.collection("companies").document(company_id)
    employees_by_id, employees_list = _load_employees(company_ref)
    if not employees_list:
        return func.HttpResponse(
            dumps({"error": "no employees"}),
            status_code=404,
            mimetype="application/json",
        )
    workitems = _load_workitems(company_ref)
    if not workitems:
        return func.HttpResponse(
            dumps({"error": "no workitems"}),
            status_code=404,
            mimetype="application/json",
        )
    payload = _build_llm_payload(employees_list, workitems)
    used_fallback = False
    try:
        assignments = _call_llm(payload)
    except Exception as exc:
        logger.exception("LLM rate generation failed: %s", exc)
        assignments = {}
    if not assignments:
        assignments = _fallback_assignments(workitems, employees_by_id)
        used_fallback = True
    summaries = _apply_assignments(company_ref, workitems, employees_by_id, assignments)
    return func.HttpResponse(
        dumps(
            {
                "ok": True,
                "used_fallback": used_fallback,
                "rates": assignments,
                "applied": summaries,
            }
        ),
        mimetype="application/json",
    )
