import azure.functions as func
import json
import logging

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, ValidationError

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value.rstrip("/")
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeployment").value
client = OpenAI(api_key=api_key, base_url=f"{endpoint}/openai/v1/")


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message: str = ""


class CancelDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cancel: bool
    confidence: float = Field(..., ge=0, le=1)
    reason: str = ""


def classify_with_llm(message: str) -> CancelDecision:
    system_message = (
        "You are a cautious classifier for customer support email to a food delivery service called Super Eats. "
        "Given the customer's note, decide whether they are asking to cancel or stop an order, delivery, "
        "subscription, or charges. Consider indirect language (e.g., want to stop, undo, wrong order, "
        "do not charge) as cancellation intent. Return ONLY JSON with keys "
        '{ "cancel": boolean, "confidence": 0-1, "reason": string }. '
        "Be concise and avoid overconfident yes answers unless the request clearly relates to stopping or "
        "reversing an order."
    )
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": message or ""},
        ],
        temperature=0.2,
        response_format=CancelDecision,
    )
    parsed = completion.choices[0].message.parsed
    if not isinstance(parsed, CancelDecision):
        raise ValueError("LLM did not return a valid CancelDecision")
    return parsed


def fallback_classify(message: str) -> CancelDecision:
    text = (message or "").lower()
    cancel_keywords = [
        "cancel",
        "stop",
        "undo",
        "reverse",
        "do not charge",
        "wrong order",
        "change my mind",
        "no longer want",
    ]
    matched = any(k in text for k in cancel_keywords)
    confidence = 0.65 if matched else 0.08
    reason = "keyword_match" if matched else "no_signal"
    return CancelDecision(cancel=matched, confidence=confidence, reason=reason)


def build_error_response(message: str, status: int = 400) -> func.HttpResponse:
    payload = {"error": message}
    return func.HttpResponse(
        json.dumps(payload), status_code=status, mimetype="application/json"
    )


def run(req: func.HttpRequest) -> func.HttpResponse:
    try:
        raw = req.get_json()
    except ValueError:
        raw = {}

    try:
        parsed = CancelRequest.model_validate(raw or {})
    except ValidationError as exc:
        return build_error_response(
            f"invalid request: {exc.errors()}", status=400
        )

    result: CancelDecision
    source = "llm"
    try:
        result = classify_with_llm(parsed.message)
    except Exception as err:
        logging.warning("LLM cancel classification failed: %s", err)
        result = fallback_classify(parsed.message)
        source = "fallback"

    payload = result.model_dump()
    payload["source"] = source
    return func.HttpResponse(
        json.dumps(payload), status_code=200, mimetype="application/json"
    )
