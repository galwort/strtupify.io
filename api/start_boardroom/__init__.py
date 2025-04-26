import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
import firebase_admin, json, uuid, datetime
from openai import AzureOpenAI
from random import gauss

vault = "https://kv-strtupifyio.vault.azure.net/"
sc = SecretClient(vault_url=vault, credential=DefaultAzureCredential())
endpoint = sc.get_secret("AIEndpoint").value
key = sc.get_secret("AIKey").value
deployment = sc.get_secret("AIDeploymentMini").value
client = AzureOpenAI(api_version="2023-07-01-preview", azure_endpoint=endpoint, api_key=key)

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


def calc_weights(emps, directive):
    sys = "Assign each participant a confidence weight 0-1 based on title, personality, and meeting directive. Return JSON."
    user = json.dumps(
        {
            "directive": directive,
            "participants": [
                {"name": e["name"], "title": e["title"], "personality": e["personality"]}
                for e in emps
            ],
        }
    )
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
    )
    raw = json.loads(rsp.choices[0].message.content)
    weights = {}
    for k, v in raw.items():
        try:
            weights[k] = max(0, min(1, float(v)))
        except (ValueError, TypeError):
            continue
    if not weights:
        for e in emps:
            weights[e["name"]] = 0.5
    return weights


def pick_first_speaker(emps, weights):
    return max(emps, key=lambda e: weights.get(e["name"], 0.4) + gauss(0, 0.05))


def gen_agent_line(agent, directive):
    sys = (
        f"You are {agent['name']}, a {agent['title']} at a brand-new startup. Personality: {agent['personality']}. "
        f"Keep your sentences concise. Meeting goal: {directive}. Begin EXACTLY one sentence."
    )
    rsp = client.chat.completions.create(
        model=deployment,
        messages=[{"role": "system", "content": sys}, {"role": "assistant", "content": f"{agent['name']}:"}],
    )
    return rsp.choices[0].message.content.strip()


def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    company = body["company"]
    directive = body.get("directive", "Come up with the company’s first product")
    emps = load_employees(company)
    if not emps:
        return func.HttpResponse(json.dumps({"error": "no employees"}), status_code=400)
    weights = calc_weights(emps, directive)
    speaker = pick_first_speaker(emps, weights)
    line = gen_agent_line(speaker, directive)
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
