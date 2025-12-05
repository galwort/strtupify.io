import azure.functions as func
import firebase_admin
import json
from datetime import datetime
from typing import Any, Dict

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, ValidationError

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value.rstrip("/")
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeployment").value
client = OpenAI(api_key=api_key, base_url=f"{endpoint}/openai/v1/")

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(json.loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()


class EvaluationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asked_for_money: bool
    compliment_score: float = Field(..., ge=0, le=10)
    gratitude_score: float = Field(..., ge=0, le=10)
    summary: str = Field(default="")


class ReplyDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    body: str = Field(..., min_length=10, max_length=6000)


def pull_company_info(company: str) -> Dict[str, Any]:
    try:
        ref = db.collection("companies").document(company)
        snap = ref.get()
        if not snap.exists:
            return {}
        data = snap.to_dict() or {}
        return {
            "company_name": data.get("company_name", ""),
            "company_description": data.get("description", ""),
        }
    except Exception:
        return {}


def evaluate_request(message: str) -> Dict[str, Any]:
    """Use the model to score money ask + compliment level."""
    system_message = (
        "You are evaluating an email that an adult child sent to their mom. "
        "Decide if they are asking for money, and how effusive they are about mom. "
        "Return ONLY JSON with keys: "
        "{ \"asked_for_money\": boolean, \"compliment_score\": number 0-10, "
        "\"gratitude_score\": number 0-10, \"summary\": string }. "
        "compliment_score measures flattery toward mom (0 = none, 10 = lavish praise). "
        "gratitude_score measures thankfulness for past help. "
        "If unsure, pick conservative lower scores."
    )
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": message or ""},
        ],
        temperature=0.0,
        response_format=EvaluationResult,
    )
    parsed = completion.choices[0].message.parsed
    if not isinstance(parsed, EvaluationResult):
        raise ValueError("LLM evaluation parsing failure")
    return parsed.model_dump()


def classify(evaluation: Dict[str, Any], already_granted: bool) -> str:
    asked = bool(evaluation.get("asked_for_money"))
    compliment_score = float(evaluation.get("compliment_score", 0) or 0)
    gratitude_score = float(evaluation.get("gratitude_score", 0) or 0)
    praise_good = (
        max(compliment_score, gratitude_score) >= 7
        or (compliment_score + gratitude_score) / 2 >= 7
    )
    if not asked:
        return "no_money"
    if praise_good and not already_granted:
        return "grant"
    if praise_good and already_granted:
        return "already_granted"
    return "needs_compliments"


def craft_reply(mode: str, subject: str, original: str, evaluation: Dict[str, Any]) -> str:
    guidance = {
        "no_money": (
            "Reply warmly but with that worried, condescending mom tone from the mom_email function. "
            "Briefly acknowledge what they wrote, and casually ask if they need money without making it a big deal."
        ),
        "needs_compliments": (
            "Reply with the same superficially kind but condescending tone. "
            "Mention they are not very complimentary or grateful while they are asking for money. "
            "Do not give money; hint they should be nicer."
        ),
        "grant": (
            "Respond with glowing warmth and clear approval. "
            "Confirm you are sending them $10,000 and act proud of their compliments. "
            "Keep the mom_email voice (concerned, slightly overbearing)."
        ),
        "already_granted": (
            "Gently but firmly note you already sent them money recently, and do not send more now. "
            "Keep the condescending mom_email tone but stay warm."
        ),
    }
    system_message = (
        "You are the user's mother replying over email. "
        "Tone: superficially kind, worried, and mildly condescending (matching the mom_email function). "
        "Keep it brief: 3-6 sentences. Avoid formal salutations like 'Dear'. "
        + guidance.get(mode, guidance["no_money"])
    )
    user_message = (
        "Subject: " + (subject or "(no subject)") + "\n\n"
        "Original message:\n" + (original or "(empty)") + "\n\n"
        "Evaluation summary:\n" + json.dumps(evaluation, ensure_ascii=False)
    )
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message},
        ],
        temperature=0.4,
        response_format=ReplyDraft,
    )
    parsed = completion.choices[0].message.parsed
    if not isinstance(parsed, ReplyDraft):
        raise ValueError("LLM reply parsing failure")
    return parsed.body


def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    company = body.get("company") or body.get("name")
    subject = body.get("subject") or "(no subject)"
    message = body.get("message") or ""

    if not company or not subject:
        return func.HttpResponse(json.dumps({"error": "missing fields"}), status_code=400)

    company_ref = db.collection("companies").document(company)
    company_info = pull_company_info(company)
    grant_state = company_ref.get()
    already_granted = False
    if grant_state.exists:
        already_granted = bool(grant_state.get("momGiftGranted"))

    try:
        evaluation = evaluate_request(message)
        mode = classify(evaluation, already_granted)
        email_body = craft_reply(mode, subject, message, evaluation)
    except (ValidationError, ValueError) as e:
        return func.HttpResponse(
            json.dumps({"error": "llm_parse_failure", "message": str(e)}),
            status_code=502,
            mimetype="application/json",
        )
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": "llm_failure", "message": str(e)}),
            status_code=502,
            mimetype="application/json",
        )

    grant_amount = 10000 if mode == "grant" else 0
    if mode == "grant":
        try:
            company_ref.set(
                {
                    "momGiftGranted": True,
                    "momGiftGrantedAt": datetime.utcnow().isoformat() + "Z",
                    "ledgerEnabled": True,
                },
                merge=True,
            )
        except Exception:
            pass

    out = {
        "from": "mom@altavista.net",
        "subject": subject,
        "body": email_body,
        "status": mode,
        "evaluation": evaluation,
        "company": company_info,
        "grant": mode == "grant",
        "amount": grant_amount,
        "ledgerMemo": "Gift from Mom" if mode == "grant" else "",
    }
    return func.HttpResponse(json.dumps(out, ensure_ascii=False), mimetype="application/json")
