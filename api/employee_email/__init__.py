import azure.functions as func
import firebase_admin
import json
import re
from typing import Any, Dict, Optional

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, firestore, initialize_app
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value.rstrip("/")
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeploymentMini").value
client = OpenAI(api_key=api_key, base_url=f"{endpoint}/openai/v1/")

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(json.loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()


class Evaluation(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    intent: str = Field(
        ...,
        pattern="^(off_hours|encouraging|discouraging|neutral)$",
        description="Classification intent",
    )
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


def normalize_address(raw: str) -> str:
    text = (raw or "").strip().lower()
    if not text:
        return ""
    match = re.search(r"<([^>]+)>", text)
    if match:
        text = match.group(1)
    return text.strip()


def normalize_domain(source: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]", "", (source or "").lower())
    return cleaned or "strtupify"


def build_worker_address(name: str, domain: str) -> str:
    base = re.sub(r"[^a-z0-9]+", ".", (name or "teammate").lower()).strip(".")
    base = base or "teammate"
    return f"{base}@{domain}"


def clamp(value: float, low: float, high: float) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        num = low
    return max(low, min(high, num))


def heuristic_intent(subject: str, message: str) -> Optional[str]:
    text = f"{subject or ''} {message or ''}".lower()
    if not text.strip():
        return None

    off_hours_terms = [
        "weekend",
        "weekends",
        "saturday",
        "sunday",
        "after hours",
        "after-hours",
        "after work",
        "late tonight",
        "tonight",
        "overtime",
        "off hours",
        "off-hours",
        "past 5",
        "past five",
        "8pm",
        "9pm",
        "10pm",
        "midnight",
    ]
    if any(term in text for term in off_hours_terms):
        return "off_hours"

    encouraging_terms = [
        "thank you",
        "thanks",
        "appreciate",
        "great job",
        "well done",
        "awesome",
        "nice work",
        "amazing",
        "proud of",
        "kudos",
        "good job",
    ]
    discouraging_terms = [
        "disappointed",
        "frustrated",
        "angry",
        "upset",
        "unacceptable",
        "furious",
        "mad",
        "bad job",
        "awful",
        "terrible",
        "horrible",
        "useless",
        "sucks",
        "let down",
    ]
    pos_hits = sum(1 for term in encouraging_terms if term in text)
    neg_hits = sum(1 for term in discouraging_terms if term in text)

    if pos_hits and pos_hits >= neg_hits:
        return "encouraging"
    if neg_hits and neg_hits > pos_hits:
        return "discouraging"
    return None


def classify_email(subject: str, message: str) -> Evaluation:
    quick_guess = heuristic_intent(subject, message)
    system = (
        "Classify the founder's email to an employee. "
        "Return JSON with fields intent (off_hours | encouraging | discouraging | neutral) and confidence (0..1). "
        "Definitions: "
        "off_hours = asks for nights, weekends, after-hours, overtime, or working outside 8am-5pm weekdays; "
        "encouraging = supportive, appreciative, motivating tone; "
        "discouraging = critical, threatening, or demoralizing tone; "
        "neutral = anything else. "
        "Assume standard work hours are 8am-5pm Monday-Friday."
    )
    payload = {"subject": subject or "", "message": message or ""}
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0.3,
        top_p=0.9,
        max_tokens=600,
        response_format=Evaluation,
    )
    parsed = completion.choices[0].message.parsed
    if not isinstance(parsed, Evaluation):
        raise ValueError("LLM parsing failure")

    if quick_guess and parsed.intent == "neutral":
        return Evaluation(intent=quick_guess, confidence=clamp(parsed.confidence or 0.55, 0.0, 1.0))
    if quick_guess and quick_guess != parsed.intent:
        if parsed.confidence is None or parsed.confidence < 0.5:
            return Evaluation(intent=quick_guess, confidence=clamp(parsed.confidence or 0.55, 0.0, 1.0))
    return parsed


def find_employee(
    company_id: str, target_email: str, explicit_id: Optional[str]
) -> Dict[str, Any] | None:
    company_ref = db.collection("companies").document(company_id)
    company_doc = company_ref.get()
    company_data = company_doc.to_dict() if company_doc.exists else {}
    domain_source = company_data.get("company_name") or company_id
    domain = f"{normalize_domain(domain_source)}.com"

    employees_ref = company_ref.collection("employees")
    employees = employees_ref.where("hired", "==", True).stream()
    normalized_target = normalize_address(target_email)

    def maybe_match(emp_doc) -> Optional[Dict[str, Any]]:
        emp = emp_doc.to_dict() or {}
        emp_id = emp_doc.id
        name = str(emp.get("name") or emp_id)
        predicted = build_worker_address(name, domain)
        id_alias = build_worker_address(emp_id, domain)
        if explicit_id and emp_id == explicit_id:
            return {**emp, "id": emp_id, "email": predicted}
        if normalized_target in {predicted.lower(), id_alias.lower()}:
            return {**emp, "id": emp_id, "email": predicted}
        return None

    for doc in employees:
        matched = maybe_match(doc)
        if matched:
            return matched
    return None


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        return func.HttpResponse(
            json.dumps({"error": "invalid json"}),
            status_code=400,
            mimetype="application/json",
        )

    company_id = str((body or {}).get("company") or "").strip()
    if not company_id:
        return func.HttpResponse(
            json.dumps({"error": "missing company"}),
            status_code=400,
            mimetype="application/json",
        )

    to_addr = str((body or {}).get("to") or "").strip()
    subject = str((body or {}).get("subject") or "").strip()
    message = str((body or {}).get("message") or "").strip()
    thread_id = str((body or {}).get("threadId") or body.get("thread_id") or "").strip()
    parent_id = str((body or {}).get("parentId") or body.get("parent_id") or "").strip()
    explicit_emp_id = str(
        (body or {}).get("employee_id") or body.get("employeeId") or ""
    ).strip()

    if not to_addr or not message:
        return func.HttpResponse(
            json.dumps({"error": "missing to or message"}),
            status_code=400,
            mimetype="application/json",
        )

    employee = find_employee(company_id, to_addr, explicit_emp_id or None)
    if not employee:
        return func.HttpResponse(
            json.dumps({"ok": True, "matched": False}),
            status_code=200,
            mimetype="application/json",
        )

    emp_name = str(employee.get("name") or employee.get("id") or "Teammate")
    emp_title = str(employee.get("title") or "").strip()
    emp_email = str(employee.get("email") or "")
    current_base = clamp(
        employee.get("stressBase") or employee.get("stress_base") or 5, 0, 100
    )
    current_per_task = clamp(
        employee.get("stressPerTask") or employee.get("stress_per_task") or 20,
        1,
        100,
    )

    try:
        evaluation = classify_email(subject, message)
        intent = evaluation.intent
    except Exception:
        intent = heuristic_intent(subject, message) or "neutral"

    updates: Dict[str, Any] = {}
    reply: Optional[Dict[str, Any]] = None
    next_base = current_base
    next_per_task = current_per_task

    if intent == "off_hours":
        updates["offHoursAllowed"] = True
        updates["stressPerTask"] = 30
        next_per_task = 30
        reply_body = f"I'll start working off hours, but heads up it will increase my stress level."
        reply = {
            "subject": f"Re: {subject}" if subject else "Re: your note",
            "body": reply_body,
            "from": emp_email or f"{emp_name.replace(' ', '').lower()}@strtupify.io",
        }
    elif intent == "encouraging":
        next_base = clamp(current_base - 5, 0, 100)
        updates["stressBase"] = next_base
        reply = {
            "subject": f"Re: {subject}" if subject else "Re: thanks",
            "body": ":)",
            "from": emp_email or f"{emp_name.replace(' ', '').lower()}@strtupify.io",
        }
    elif intent == "discouraging":
        next_base = clamp(current_base + 5, 0, 100)
        updates["stressBase"] = next_base
        reply = {
            "subject": f"Re: {subject}" if subject else "Re:",
            "body": ":(",
            "from": emp_email or f"{emp_name.replace(' ', '').lower()}@strtupify.io",
        }

    if updates:
        updates["updated"] = firestore.SERVER_TIMESTAMP
        db.collection("companies").document(company_id).collection(
            "employees"
        ).document(employee["id"]).set(updates, merge=True)

    off_hours_allowed = (
        updates["offHoursAllowed"]
        if "offHoursAllowed" in updates
        else bool(
            employee.get("offHoursAllowed")
            or employee.get("off_hours_allowed")
            or False
        )
    )

    response_payload = {
        "ok": True,
        "matched": True,
        "intent": intent,
        "employee": {
            "id": employee["id"],
            "name": emp_name,
            "title": emp_title,
            "email": emp_email,
        },
        "stressBase": next_base,
        "stressPerTask": next_per_task,
        "offHoursAllowed": off_hours_allowed,
        "reply": reply,
        "threadId": thread_id,
        "parentId": parent_id,
    }

    return func.HttpResponse(
        json.dumps(response_payload, ensure_ascii=False),
        status_code=200,
        mimetype="application/json",
    )
