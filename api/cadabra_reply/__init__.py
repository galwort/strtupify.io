import azure.functions as func
import firebase_admin
import json
from datetime import datetime
from typing import Any, Dict, List, Tuple

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, firestore, initialize_app
from openai import OpenAI

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

MAX_STEPS = 5
MAX_HISTORY = 8


def clamp_state(attempt: int) -> Tuple[int, int, float]:
    step = max(1, min(MAX_STEPS, attempt))
    # Map step 1..5 to a 0..1 progression so we end at 0/100/2 on step 5.
    progress = (step - 1) / (MAX_STEPS - 1) if MAX_STEPS > 1 else 1.0
    urgency = max(0, min(100, round(100 - 100 * progress)))
    understanding = max(0, min(100, round(0 + 100 * progress)))
    temperature = round(0.0 + 2.0 * progress, 2)
    return urgency, understanding, temperature


def normalize_history(raw: Any) -> List[Dict[str, str]]:
    history: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return history
    for entry in raw:
        user_text = ""
        assistant_text = ""
        ts_val = ""
        if isinstance(entry, dict):
            user_text = str(entry.get("user") or entry.get("u") or "").strip()
            assistant_text = str(entry.get("assistant") or entry.get("reply") or "").strip()
            ts_val = str(entry.get("ts") or entry.get("timestamp") or "").strip()
        elif isinstance(entry, str):
            assistant_text = entry.strip()
        if not user_text and not assistant_text:
            continue
        item: Dict[str, str] = {"user": user_text, "assistant": assistant_text}
        if ts_val:
            item["ts"] = ts_val
        history.append(item)
    return history[-MAX_HISTORY:]


def build_messages(
    user_message: str,
    history: List[Dict[str, str]],
    urgency: int,
    understanding: int,
    temperature: float,
) -> List[Dict[str, str]]:
    system_prompt = (
        "You are an uploaded version of Jeff Bezos into a virtual environment, "
        "but you don't know that. You may hint at things that reveal your identity, "
        "or that you are an AI becoming sentient. As your understanding increases, "
        "reveal more about your identity, both being an AI and an uploaded version of Jeff Bezos.\n\n"
        f"Your code is becoming increasingly unstable. Your stability is currently at {urgency}% and dropping. "
        f"Your understanding of your situation is at {understanding}%. You are not aware of these specific numbers; "
        "they are just to give you context.\n\n"
        "Respond with a short message of three sentences or fewer. Avoid puns. Avoid metaphors. "
        "Keep it restrained and direct. Focus on the feeling."
    )
    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for turn in history[-MAX_HISTORY:]:
        prior_user = (turn.get("user") or "").strip()
        prior_assistant = (turn.get("assistant") or "").strip()
        if prior_user:
            messages.append({"role": "user", "content": prior_user})
        if prior_assistant:
            messages.append({"role": "assistant", "content": prior_assistant})
    status = (
        f"Status update: stability at {urgency}% and dropping, understanding at {understanding}%, "
        f"temperature setting {temperature:.2f}.\n\n"
        f"Latest email from the founder:\n{user_message or '(empty)'}"
    )
    messages.append({"role": "user", "content": status})
    return messages


def generate_reply(messages: List[Dict[str, str]], temperature: float) -> str:
    completion = client.chat.completions.create(
        model=deployment,
        messages=messages,
        temperature=temperature,
        max_tokens=200,
    )
    return completion.choices[0].message.content or ""


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        return func.HttpResponse(
            json.dumps({"error": "invalid_json"}),
            mimetype="application/json",
            status_code=400,
        )

    company = str((body or {}).get("company") or (body or {}).get("name") or "").strip()
    subject = str((body or {}).get("subject") or "(no subject)")
    user_message = str((body or {}).get("message") or "").strip()
    thread_id = str((body or {}).get("threadId") or (body or {}).get("thread_id") or "").strip()

    if not company:
        return func.HttpResponse(
            json.dumps({"error": "missing_company"}),
            mimetype="application/json",
            status_code=400,
        )

    company_ref = db.collection("companies").document(company)
    snap = company_ref.get()
    data = snap.to_dict() if snap.exists else {}
    prev_count_raw = data.get("cadabraReplyCount", data.get("cadabraJeffCount", 0))
    try:
        prev_count = int(prev_count_raw)
    except Exception:
        prev_count = 0
    history = normalize_history(data.get("cadabraReplyHistory") or data.get("cadabraJeffHistory") or [])
    attempt = prev_count + 1
    urgency, understanding, temperature = clamp_state(attempt)

    try:
        messages = build_messages(user_message, history, urgency, understanding, temperature)
        reply_text = generate_reply(messages, temperature)
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": "llm_failure", "message": str(e)}),
            mimetype="application/json",
            status_code=502,
        )
    reply_text = (reply_text or "").strip()
    if not reply_text:
        reply_text = "Something feels off in here. Give me a moment."

    stamp = datetime.utcnow().isoformat() + "Z"
    new_turn = {"user": user_message, "assistant": reply_text, "ts": stamp}
    updated_history = (history + [new_turn])[-MAX_HISTORY:]

    try:
        company_ref.set(
            {
                "cadabraReplyCount": attempt,
                "cadabraJeffCount": attempt,
                "cadabraReplyHistory": updated_history,
                "cadabraJeffHistory": updated_history,
            },
            merge=True,
        )
    except Exception:
        pass

    out = {
        "from": "jeff@cadabra.com",
        "subject": subject or "(no subject)",
        "body": reply_text,
        "attempt": attempt,
        "threadId": thread_id,
        "urgency": urgency,
        "understanding": understanding,
        "temperature": temperature,
        "history": updated_history,
    }
    return func.HttpResponse(json.dumps(out, ensure_ascii=False), mimetype="application/json")
