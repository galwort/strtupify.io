import azure.functions as func
import firebase_admin
import json
from typing import Any, Dict, List

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

MIN_MULTIPLIER = 0.20
MAX_MULTIPLIER = 1.50
NO_REPLY_PHRASES = [
    "let me know",
    "let us know",
    "please advise",
    "could you",
    "can you",
    "would you",
    "please reply",
    "please respond",
    "get back to me",
    "awaiting your response",
    "any questions",
]


class ProductInfo(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(..., min_length=1, max_length=5000)


class WorkItemInfo(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str | None = Field(default=None, max_length=200)
    title: str = Field(..., min_length=1, max_length=300)
    description: str = Field(..., min_length=1, max_length=6000)
    category: str | None = Field(default=None, max_length=200)


class WorkerContext(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(..., min_length=2, max_length=200)
    title: str = Field(..., min_length=2, max_length=200)


class WorkerEmail(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    subject: str = Field(..., min_length=5, max_length=300)
    body: str = Field(..., min_length=20, max_length=6000)
    question: str = Field(..., min_length=5, max_length=400)
    pause_reason: str | None = Field(default=None, max_length=300)
    tone: str | None = Field(default=None, max_length=100)


class ThreadItem(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str | None = None
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    subject: str | None = None
    message: str | None = None
    timestamp: str | None = None


class ReplyInfo(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    text: str = Field(..., min_length=1, max_length=6000)
    thread: List[ThreadItem] = Field(default_factory=list)


class WorkerFollowUp(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    subject: str = Field(..., min_length=5, max_length=300)
    body: str = Field(..., min_length=20, max_length=6000)
    tone: str = Field(..., min_length=3, max_length=60)


class AssistReviewResult(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    helpfulness: str = Field(..., min_length=3, max_length=40)
    reasoning: str = Field(..., min_length=20, max_length=800)
    multiplier: float = Field(..., ge=MIN_MULTIPLIER, le=MAX_MULTIPLIER)
    confidence: float = Field(..., ge=0.0, le=1.0)
    improvements: List[str] = Field(default_factory=list)
    follow_up: WorkerFollowUp


def sanitize_follow_up(body: str, workitem_title: str) -> str:
    text = (body or "").strip()
    lowered = text.lower()
    if "?" in text:
        text = ""
    else:
        for phrase in NO_REPLY_PHRASES:
            if phrase in lowered:
                text = ""
                break
    if text:
        return text
    fallback = "Thanks for the direction. I'm applying it now and will keep things moving."
    if workitem_title:
        fallback = (
            f"Thanks for the direction on {workitem_title}. "
            "I'm applying it now and will keep things moving."
        )
    return fallback


def _call_llm(payload: Dict[str, Any]) -> AssistReviewResult:
    system_message = (
        "You review a founder's reply to a teammate's help request. "
        "Score the reply, decide a speed multiplier between 0.20 and 1.50, "
        "and craft the teammate's appreciative follow-up email. "
        "The follow-up must never ask for more information or a response; "
        "it should be a brief acknowledgement that they're applying the guidance and moving forward. "
        "Return only JSON that matches the schema."
    )
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0.4,
        top_p=0.9,
        max_tokens=2048,
        response_format=AssistReviewResult,
    )
    parsed = completion.choices[0].message.parsed
    if not isinstance(parsed, AssistReviewResult):
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

    payload = body or {}
    try:
        product = ProductInfo(**(payload.get("product") or {}))
        workitem = WorkItemInfo(**(payload.get("workitem") or {}))
        worker = WorkerContext(**(payload.get("worker") or {}))
        email = WorkerEmail(**(payload.get("email") or {}))
        reply = ReplyInfo(**(payload.get("reply") or {}))
    except ValidationError as exc:
        return func.HttpResponse(
            json.dumps({"error": "invalid payload", "details": exc.errors()}),
            mimetype="application/json",
            status_code=400,
        )

    thread_subject = ""
    for item in reversed(reply.thread or []):
        subj = (item.subject or "").strip()
        if subj:
            thread_subject = subj
            break
    base_subject = thread_subject or email.subject

    company_snap = db.collection("companies").document(company_id).get()
    company_data = company_snap.to_dict() if company_snap.exists else {}
    company_name = str(company_data.get("company_name") or company_id)

    llm_payload: Dict[str, Any] = {
        "company": {"id": company_id, "name": company_name},
        "product": product.model_dump(),
        "workitem": workitem.model_dump(),
        "worker": worker.model_dump(),
        "email": email.model_dump(),
        "reply": {
            "text": reply.text,
            "thread": [
                {
                    "from": item.from_,
                    "to": item.to,
                    "subject": item.subject,
                    "message": item.message,
                    "timestamp": item.timestamp,
                }
                for item in reply.thread
            ],
        },
        "grading_criteria": {
            "excellent": "Direct answer, actionable guidance, addresses blocker, adds clarity",
            "helpful": "Mostly answers with minor gaps",
            "mixed": "Some help but misses key detail",
            "unhelpful": "Does not unblock",
            "harmful": "Makes progress harder"
        },
        "multiplier_bounds": {
            "min": MIN_MULTIPLIER,
            "max": MAX_MULTIPLIER,
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

    multiplier = max(MIN_MULTIPLIER, min(MAX_MULTIPLIER, float(parsed.multiplier)))
    follow_body = sanitize_follow_up(parsed.follow_up.body, workitem.title)

    response_payload = {
        "helpfulness": parsed.helpfulness,
        "reasoning": parsed.reasoning,
        "multiplier": round(multiplier, 4),
        "confidence": parsed.confidence,
        "improvements": parsed.improvements,
        "follow_up": {
            "subject": base_subject,
            "body": follow_body,
            "tone": parsed.follow_up.tone,
        },
    }

    return func.HttpResponse(
        json.dumps(response_payload, ensure_ascii=False),
        mimetype="application/json",
    )
