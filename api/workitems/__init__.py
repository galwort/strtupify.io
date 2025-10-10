import azure.functions as func
import firebase_admin
import logging
import math
import time
from json import dumps, loads
from typing import Any, Dict, List, Tuple

from enum import Enum
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, firestore, initialize_app
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, create_model

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value.rstrip("/")
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeploymentMini").value
base_url = f"{endpoint}/openai/v1/"
API_VERSION = "2024-08-01-preview"
plan_client = OpenAI(
    api_key=api_key,
    base_url=base_url,
)
structured_client = OpenAI(
    api_key=api_key,
    base_url=base_url,
)

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()

MAX_EMPLOYEES = 25
MAX_SKILLS_PER_EMPLOYEE = 12
MAX_WORKITEMS = 60
MIN_RATE = 0.1
MAX_RATE = 5.0

logger = logging.getLogger("workitems_llm")


class RateAssignments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignments: List[Dict[str, Any]]


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


def _prepare_employees_for_rates(
    raw_employees: List[Dict[str, Any]],
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    employees_by_id: Dict[str, Dict[str, Any]] = {}
    ordered: List[Dict[str, Any]] = []
    for emp in raw_employees or []:
        emp_id = str(emp.get("id") or "").strip()
        if not emp_id:
            continue
        skills_list: List[Dict[str, Any]] = []
        for skill in (emp.get("skills") or [])[:MAX_SKILLS_PER_EMPLOYEE]:
            title = str((skill or {}).get("skill") or "").strip()
            if not title:
                continue
            lvl_raw = (skill or {}).get("level", 5)
            try:
                lvl = int(lvl_raw)
            except (TypeError, ValueError):
                lvl = 5
            lvl = max(1, min(10, lvl))
            skills_list.append({"skill": title, "level": lvl})
        if not skills_list:
            skills_list.append({"skill": "generalist", "level": 5})
        record = {
            "id": emp_id,
            "name": str(emp.get("name") or "").strip(),
            "title": str(emp.get("title") or "").strip(),
            "skills": skills_list,
        }
        employees_by_id[emp_id] = record
        ordered.append({"id": emp_id, "title": record["title"], "skills": skills_list})
        if len(ordered) >= MAX_EMPLOYEES:
            break
    return employees_by_id, ordered


def _build_rate_payload(
    employees_payload: List[Dict[str, Any]], workitems_payload: List[Dict[str, Any]]
) -> Dict[str, Any]:
    return {
        "employees": employees_payload,
        "workitems": [
            {
                "id": itm["id"],
                "title": itm["title"],
                "description": itm["description"],
                "category": itm["category"],
                "complexity": max(1, min(5, _safe_int(itm.get("complexity"), 3))),
            }
            for itm in workitems_payload
        ],
        "instructions": (
            "For every work item return an object with fields workitem_id and employees. "
            "employees is an array that lists every employee exactly once. "
            "Each entry has fields employee_id and rate. "
            "Rate must be between 0.1 and 5.0."
        ),
        "rate_scale": "percentage of work completed per simulated hour",
    }


def _call_rate_assignments(payload: Dict[str, Any]) -> Dict[str, Dict[str, float]]:
    if not payload.get("employees") or not payload.get("workitems"):
        return {}
    employee_ids = [str(e["id"]) for e in payload.get("employees", [])]
    workitem_ids = [str(w["id"]) for w in payload.get("workitems", [])]
    EmpEnum = Enum("EmpEnum", {f"e_{i}": v for i, v in enumerate(employee_ids)})
    WorkEnum = Enum("WorkEnum", {f"w_{i}": v for i, v in enumerate(workitem_ids)})

    class SOModel(BaseModel):
        model_config = ConfigDict(extra="forbid")

    RateCellDyn = create_model(
        "RateCellDyn",
        __base__=SOModel,
        employee_id=(EmpEnum, ...),
        rate=(float, Field(..., ge=MIN_RATE, le=MAX_RATE)),
    )
    WorkItemRatesDyn = create_model(
        "WorkItemRatesDyn",
        __base__=SOModel,
        workitem_id=(WorkEnum, ...),
        employees=(
            List[RateCellDyn],
            Field(..., min_length=len(employee_ids), max_length=len(employee_ids)),
        ),
    )
    RateAssignmentsDyn = create_model(
        "RateAssignmentsDyn",
        __base__=SOModel,
        assignments=(
            List[WorkItemRatesDyn],
            Field(..., min_length=len(workitem_ids), max_length=len(workitem_ids)),
        ),
    )
    system = (
        "You are an expert workforce planner. "
        "Return only JSON that conforms to the schema. "
        f"Rates must be between {MIN_RATE} and {MAX_RATE}. "
        "For each work item include workitem_id and an employees array that contains every employee exactly once."
    )
    user = dumps(payload)
    completion = structured_client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
        top_p=0.9,
        max_tokens=8192,
        response_format=RateAssignmentsDyn,
    )
    parsed = completion.choices[0].message.parsed
    assignments_list = getattr(parsed, "assignments", [])
    mapped: Dict[str, Dict[str, float]] = {}
    for row in assignments_list:
        emp_map: Dict[str, float] = {}
        for cell in row.employees:
            emp_map[str(cell.employee_id.value)] = float(cell.rate)
        mapped[str(row.workitem_id.value)] = emp_map
    for wid in workitem_ids:
        if wid not in mapped:
            mapped[wid] = {}
        for eid in employee_ids:
            if eid not in mapped[wid]:
                mapped[wid][eid] = 1.0
    return {
        wid: {eid: _clamp_rate(rate) for eid, rate in (emps or {}).items()}
        for wid, emps in mapped.items()
    }


def _fallback_assignments(
    workitems_payload: List[Dict[str, Any]], employees_by_id: Dict[str, Dict[str, Any]]
) -> Dict[str, Dict[str, float]]:
    if not employees_by_id or not workitems_payload:
        return {}
    default_rate = 1.0
    return {
        wi["id"]: {emp_id: default_rate for emp_id in employees_by_id.keys()}
        for wi in workitems_payload
    }


def _apply_llm_rates(
    company_ref,
    created_items: List[Dict[str, Any]],
    raw_employees: List[Dict[str, Any]],
):
    if not created_items:
        return
    employees_by_id, employees_payload = _prepare_employees_for_rates(raw_employees)
    if not employees_payload:
        return
    workitems_payload: List[Dict[str, Any]] = []
    for item in created_items[:MAX_WORKITEMS]:
        workitems_payload.append(
            {
                "id": item["doc_id"],
                "title": item["title"],
                "description": item["description"],
                "category": item["category"],
                "complexity": item.get("complexity", 3),
            }
        )
    if not workitems_payload:
        return
    try:
        payload = _build_rate_payload(employees_payload, workitems_payload)
        assignments = _call_rate_assignments(payload)
    except Exception as exc:
        logger.exception(
            "LLM rate generation failed during workitem bootstrap: %s", exc
        )
        assignments = {}
    if not assignments:
        assignments = _fallback_assignments(workitems_payload, employees_by_id)
    work_ref = company_ref.collection("workitems")
    for item in created_items:
        doc_id = item["doc_id"]
        rates = assignments.get(doc_id)
        if not rates:
            continue
        normalized = {
            emp_id: _clamp_rate(rate)
            for emp_id, rate in rates.items()
            if emp_id in employees_by_id
        }
        if not normalized:
            continue
        rounded_rates = {emp_id: round(val, 4) for emp_id, val in normalized.items()}
        best_emp, best_rate = max(rounded_rates.items(), key=lambda pair: pair[1])
        est_hours = _hours_from_rate(best_rate)
        update_doc: Dict[str, Any] = {
            "rate_source": "llm_structured",
            "rate_per_hour": best_rate,
            "estimated_hours": est_hours,
            "updated": firestore.SERVER_TIMESTAMP,
            "llm_rates.rates": rounded_rates,
            "llm_rates.assigned_employee_id": best_emp,
            "llm_rates.assigned_rate": best_rate,
            "llm_rates.rate_units": "percent_per_hour",
            "llm_rates.model": deployment,
            "llm_rates.generated": firestore.SERVER_TIMESTAMP,
            "llm_rates.updated": firestore.SERVER_TIMESTAMP,
        }
        status = str(item.get("status") or "").lower()
        if status != "done":
            update_doc["assignee_id"] = best_emp
        try:
            work_ref.document(doc_id).update(update_doc)
        except Exception as exc:
            logger.debug(
                "failed to update work item %s with LLM rates: %s", doc_id, exc
            )


def pull_context(company):
    company_ref = db.collection("companies").document(company)
    c = company_ref.get().to_dict() or {}
    products = company_ref.collection("products").where("accepted", "==", True).get()
    product = None
    for p in products:
        product = p.to_dict() | {"id": p.id}
        break
    boardroom = []
    if product:
        raw_board = product.get("boardroom") or []
        for entry in raw_board:
            if not isinstance(entry, dict):
                continue
            boardroom.append(
                {
                    "speaker": str(entry.get("speaker", "")),
                    "message": str(
                        (entry.get("msg") or entry.get("message") or "")
                    ).strip(),
                    "stage": str(entry.get("stage", "")),
                    "timestamp": str(entry.get("at", "")),
                }
            )
    employees = []
    for d in company_ref.collection("employees").where("hired", "==", True).stream():
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
            skills.append(
                {
                    "skill": sd.get("skill"),
                    "level": sd.get("level", 5),
                }
            )
        emp_raw["skills"] = skills
        employees.append(emp_raw)
    return {
        "company": c,
        "product": product,
        "employees": employees,
        "boardroom": boardroom,
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
    boardroom_history = []
    for entry in ctx.get("boardroom") or []:
        if not isinstance(entry, dict):
            continue
        message = str((entry.get("message") or entry.get("msg") or "")).strip()
        if not message:
            continue
        boardroom_history.append(
            {
                "speaker": str(entry.get("speaker", "")),
                "message": message,
                "stage": str(entry.get("stage", "")),
            }
        )
    boardroom_transcript = "\n".join(
        f"{(b.get('speaker', '').strip() or 'Unknown')}: {b.get('message', '')}"
        for b in boardroom_history
    )
    employees = ctx.get("employees", [])
    sys = (
        "Create a comprehensive set of work items to deliver the proposed MVP end to end. "
        "Return strict JSON with key 'workitems' as a list. Each item must have: "
        "title, description, assignee_name, category, complexity. "
        "complexity is an integer 1 to 5. "
        "Use employees names and titles to assign appropriately, matching skills and seniority. "
        "Cover cross functional needs. "
        "Ground the plan in the boardroom_history transcript so the tasks reflect the ideas, objections, and decisions the team discussed. "
        "Aim for a complete plan rather than a starter list. Return between 15 and 40 items based on scope and team size. "
        "If funding or loan details are provided, explicitly include early revenue generation work so the company can make money quickly. "
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
                        {
                            "skill": (s or {}).get("skill"),
                            "level": (s or {}).get("level", 5),
                        }
                        for s in (e.get("skills", []) or [])
                    ],
                }
                for e in employees
            ],
            "boardroom_history": boardroom_history,
            "boardroom_transcript": boardroom_transcript,
        }
    )
    rsp = plan_client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": sys},
            {"role": "user", "content": user},
        ],
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
                        "description": "Deliver the first user facing capability",
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
        normalized.append(
            {
                "title": t,
                "description": d,
                "category": cat,
                "complexity": cx,
                "assignee_name": nm,
                "assignee_id": emp.get("id", ""),
            }
        )

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
        if any(
            k in c
            for k in [
                "engineer",
                "eng",
                "dev",
                "frontend",
                "backend",
                "data",
                "infra",
                "ops",
                "platform",
                "security",
            ]
        ):
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
    created_items: List[Dict[str, Any]] = []
    for idx, wi in enumerate(normalized):
        assignee_name = wi.get("assignee_name", "")
        emp = emps_by_name.get(assignee_name) or {}
        emp_id = str(wi.get("assignee_id") or emp.get("id") or "")
        emp_level = level_avg(emp)
        cx = int(wi.get("complexity", 3))
        est = estimate_hours(cx, emp_level)
        tid = start_tid + idx
        doc_id = str(tid)
        fallback_rate = round(100.0 / max(1, est), 4)
        work_ref.document(doc_id).set(
            {
                "tid": tid,
                "title": wi.get("title", ""),
                "description": wi.get("description", ""),
                "assignee_id": emp_id,
                "category": wi.get("category", ""),
                "estimated_hours": est,
                "rate_per_hour": fallback_rate,
                "status": "todo",
                "work_start_hour": 10,
                "work_end_hour": 20,
                "blockers": blockers_by_idx.get(idx, []),
                "created": firestore.SERVER_TIMESTAMP,
                "updated": firestore.SERVER_TIMESTAMP,
            }
        )
        created_items.append(
            {
                "doc_id": doc_id,
                "title": wi.get("title", ""),
                "description": wi.get("description", ""),
                "category": wi.get("category", ""),
                "complexity": cx,
                "status": "todo",
                "assignee_id": emp_id,
            }
        )
    try:
        _apply_llm_rates(company_ref, created_items, ctx.get("employees", []))
    except Exception as exc:
        logger.exception(
            "Failed to apply structured rates after creating work items: %s", exc
        )
    company_ref.set(
        {"work_enabled": True, "work_created_at": firestore.SERVER_TIMESTAMP},
        merge=True,
    )


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
        return func.HttpResponse(
            dumps({"error": "no accepted product"}), status_code=400
        )
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
                return func.HttpResponse(
                    dumps({"ok": True, "skipped": True}), mimetype="application/json"
                )
        except Exception:
            pass
    planned = llm_plan(ctx)
    ensure_items(company, ctx, planned, start_at)
    return func.HttpResponse(dumps({"ok": True}), mimetype="application/json")
