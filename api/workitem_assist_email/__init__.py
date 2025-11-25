import azure.functions as func
import firebase_admin
import json
import re
from typing import Any, Dict

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, firestore, initialize_app
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, ValidationError

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


class ProductInfo(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(..., min_length=1, max_length=5000)


class AssigneeInfo(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=200)


class WorkItemInfo(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str | None = Field(default=None, max_length=200)
    title: str = Field(..., min_length=1, max_length=300)
    description: str = Field(..., min_length=1, max_length=6000)
    category: str | None = Field(default=None, max_length=200)
    assignee: AssigneeInfo | None = None


class WorkerAssistEmail(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    subject: str = Field(..., min_length=5, max_length=300)
    body: str = Field(..., min_length=40, max_length=6000)
    question: str = Field(..., min_length=5, max_length=400)
    pause_reason: str = Field(..., min_length=5, max_length=300)
    tone: str = Field(..., min_length=3, max_length=60)
    confidence: float = Field(..., ge=0.0, le=1.0)


class AssistEmailResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    summary: str = Field(..., min_length=10, max_length=400)
    email: WorkerAssistEmail
    talking_points: list[str] = Field(default_factory=list)


def _slugify_localpart(name: str) -> str:
    lowered = name.strip().lower()
    if not lowered:
        return "team"
    replaced = re.sub(r"[^a-z0-9]+", ".", lowered)
    trimmed = replaced.strip(".")
    return trimmed or "team"


def _load_company(company_id: str) -> Dict[str, str]:
    snap = db.collection("companies").document(company_id).get()
    data = snap.to_dict() if snap.exists else {}
    company_name = str(data.get("company_name") or company_id).strip()
    normalized = re.sub(r"[^a-z0-9]", "", company_name.lower()) or company_id.lower()
    domain = f"{normalized}.com"
    return {
        "name": company_name or company_id,
        "domain": domain,
        "me_address": f"me@{domain}",
    }


def _call_llm(payload: Dict[str, Any]) -> AssistEmailResponse:
    system_message = (
        "You are roleplaying a teammate who paused work on a startup deliverable. "
        "Write a concise, human email to the founder explaining the blocker and ask exactly one question. "
        "Return only JSON that matches the schema."
    )
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0.6,
        top_p=0.9,
        max_tokens=2048,
        response_format=AssistEmailResponse,
    )
    parsed = completion.choices[0].message.parsed
    if not isinstance(parsed, AssistEmailResponse):
        raise ValueError("LLM parsing failure")
    return parsed


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        return func.HttpResponse(
            json.dumps({"error": "invalid json"}),
            mimetype="application/json",
            status_code=400,
        )

    company_id = str((body or {}).get("company") or "").strip()
    if not company_id:
        return func.HttpResponse(
            json.dumps({"error": "missing company"}),
            mimetype="application/json",
            status_code=400,
        )

    try:
        product = ProductInfo(**(body.get("product") or {}))
        workitem = WorkItemInfo(**(body.get("workitem") or {}))
    except ValidationError as exc:
        return func.HttpResponse(
            json.dumps({"error": "invalid payload", "details": exc.errors()}),
            mimetype="application/json",
            status_code=400,
        )

    company = _load_company(company_id)
    assignee = workitem.assignee or AssigneeInfo()
    if not assignee.name or not assignee.title:
        return func.HttpResponse(
            json.dumps({"error": "missing_assignee_identity"}),
            mimetype="application/json",
            status_code=400,
        )

    llm_payload: Dict[str, Any] = {
        "company": {
            "name": company.get("name"),
            "domain": company.get("domain"),
        },
        "product": product.model_dump(),
        "workitem": workitem.model_dump(),
        "instructions": {
            "focus": "Explain why progress is paused and ask the founder for input.",
            "question_requirements": "Ask a single, concrete question the founder can answer in one reply.",
            "tone": "Respectful, collaborative, concise."
        },
    }

    try:
        parsed = _call_llm(llm_payload)
    except Exception as exc:
        return func.HttpResponse(
            json.dumps({"error": "llm_failure", "message": str(exc)}),
            mimetype="application/json",
            status_code=502,
        )

    sender_name = (assignee.name or "").strip() or "Product Teammate"
    sender_title = (assignee.title or "").strip() or "Contributor"
    local_part = _slugify_localpart(sender_name)
    from_address = f"{local_part}@{company['domain']}"

    response_payload = {
        "ok": True,
        "email": {
            "from": from_address,
            "sender_name": sender_name,
            "sender_title": sender_title,
            "subject": parsed.email.subject,
            "body": parsed.email.body,
            "question": parsed.email.question,
            "pause_reason": parsed.email.pause_reason,
            "tone": parsed.email.tone,
            "confidence": parsed.email.confidence,
        },
        "summary": parsed.summary,
        "talking_points": parsed.talking_points,
        "company": company,
    }

    return func.HttpResponse(
        json.dumps(response_payload, ensure_ascii=False),
        mimetype="application/json",
    )
