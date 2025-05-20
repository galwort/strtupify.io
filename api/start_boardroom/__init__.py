import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
import firebase_admin, json, uuid, datetime
from openai import AzureOpenAI
from random import gauss

DIRECTIVE = (
    "This is the first meeting of a new startup. "
    "The goal is to come up with the first product or service that the company will offer. "
    "Reminder that this is the first meeting between the employees, "
    "so they don't know each other yet. "
)

vault = "https://kv-strtupifyio.vault.azure.net/"
sc = SecretClient(vault_url=vault, credential=DefaultAzureCredential())
endpoint = sc.get_secret("AIEndpoint").value
key = sc.get_secret("AIKey").value
deployment = sc.get_secret("AIDeploymentMini").value
client = AzureOpenAI(
    api_version="2023-07-01-preview", azure_endpoint=endpoint, api_key=key
)

cred = credentials.Certificate(json.loads(sc.get_secret("FirebaseSDK").value))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()


def load_employees(company):
    docs = (
        db.collection("companies")
        .document(company)
        .collection("employees")
        .where("hired", "==", True)
        .stream()
    )
    return [d.to_dict() | {"id": d.id} for d in docs]


def load_company_description(company):
    doc = db.collection("companies").document(company).get()
    if doc.exists:
        return doc.to_dict().get("description", "")
    return ""


def calc_weights(emps, directive):
    sys = (
        "Re-evaluate each participant’s confidence weight (0-1) for the *next* turn.\n"
        "• Start from their previous weight if given.\n"
        "• **Increase** if their most recent comment advanced the meeting goal.\n"
        "• **Decrease** if they sounded uncertain, repetitive, or off-topic.\n"
        "Return JSON: {name: weight}.  At least one ≥0.75 and one ≤0.25."
    )
    user = json.dumps(
        {
            "directive": directive,
            "participants": [
                {
                    "name": e["name"],
                    "title": e["title"],
                    "personality": e["personality"],
                }
                for e in emps
            ],
        }
    )
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": sys},
            {"role": "user", "content": user},
        ],
    )
    raw = json.loads(rsp.choices[0].message.content)
    weights = {
        k: max(0, min(1, float(v)))
        for k, v in raw.items()
        if isinstance(v, (int, float, str))
    }
    if len(set(weights.values())) <= 1:
        for e in emps:
            weights[e["name"]] = max(0, min(1, gauss(0.5, 0.15)))
    return weights


def pick_first_speaker(emps, weights):
    return max(emps, key=lambda e: weights.get(e["name"], 0.4) + gauss(0, 0.05))


def gen_agent_line(agent, directive, company, company_description, emp_names):
    sys = (
        f"You are {agent['name']}, a {agent['title']} at a new startup. "
        f"Company: {company}. Company description: {company_description}. "
        f"Personality: {agent['personality']}. Meeting goal: {directive} "
        f"You should respond naturally as if you are in a real meeting. "
        f"When replying to someone, AVOID mentioning them by name. "
        f"Your responses should be more natural which means you can use filler words, pauses, and other natural speech patterns. "
        f"Sometimes you may question, disagree, or express doubts about what was said before you. "
        f"Your response should still feel collaborative but not always perfectly aligned. "
        f"Respond with a single natural-sounding line of dialogue."
        f"So far, no minutes have passed in the meeting, "
        f"which means you are in the INTRODUCTION stage of the meeting. "
    )
    msgs = [{"role": "system", "content": sys}]
    msgs.append({"role": "user", "content": f"{agent['name']}:"})
    rsp = client.chat.completions.create(model=deployment, messages=msgs)
    content = rsp.choices[0].message.content or ""
    for name in emp_names:
        low = name.lower()
        first = name.split()[0].lower()
        if content.lower().startswith(low):
            content = content[len(name) :].lstrip(":,.- ").strip()
            break
        if content.lower().startswith(first):
            content = content[len(first) :].lstrip(":,.- ").strip()
            break
    return content.strip()


def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    company = body["company"]
    emps = load_employees(company)
    emp_names = [e["name"] for e in emps]
    if not emps:
        return func.HttpResponse(json.dumps({"error": "no employees"}), status_code=400)
    company_description = load_company_description(company)
    weights = calc_weights(emps, DIRECTIVE)
    speaker = pick_first_speaker(emps, weights)
    line = gen_agent_line(speaker, DIRECTIVE, company, company_description, emp_names)
    doc_ref = (
        db.collection("companies")
        .document(company)
        .collection("products")
        .document(str(uuid.uuid4()))
    )
    doc_ref.set(
        {
            "boardroom": [
                {
                    "speaker": speaker["name"],
                    "msg": line,
                    "weights": weights,
                    "stage": "INTRODUCTION",
                    "at": datetime.datetime.utcnow().isoformat(),
                }
            ],
            "product": "",
            "description": "",
            "created": firestore.SERVER_TIMESTAMP,
            "updated": firestore.SERVER_TIMESTAMP,
        }
    )
    return func.HttpResponse(
        json.dumps({"productId": doc_ref.id, "speaker": speaker["name"], "line": line}),
        mimetype="application/json",
    )
