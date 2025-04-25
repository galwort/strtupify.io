import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
import firebase_admin
from openai import AzureOpenAI
from random import gauss
import json, uuid

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
    system_message = (
        "You assign each participant a confidence weight between 0 and 1 based on their title, "
        "personality, and the meeting directive. Return only JSON mapping names to numbers."
    )
    user_message = json.dumps(
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
        messages=[{"role": "system", "content": system_message}, {"role": "user", "content": user_message}],
    )
    data = json.loads(rsp.choices[0].message.content)
    return {k: max(0, min(1, float(v))) for k, v in data.items()}


def pick_first_speaker(emps, weights):
    return max(emps, key=lambda e: weights.get(e["name"], 0.4) + gauss(0, 0.05))


def gen_agent_line(agent, history, directive):
    sys = (
        f"You are {agent['name']}, a {agent['title']} at a brand-new startup. Personality: {agent['personality']}. "
        f"Keep your sentences concise. The meeting goal is: {directive}. Begin EXACTLY one sentence."
    )
    msgs = [{"role": "system", "content": sys}]
    for h in history[-6:]:
        msgs.append({"role": "assistant", "content": f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role": "assistant", "content": f"{agent['name']}:"})
    rsp = client.chat.completions.create(model=deployment, messages=msgs)
    return rsp.choices[0].message.content.strip()


def store_product(company, speaker, line, directive, weights):
    ref = (
        db.collection("companies")
        .document(company)
        .collection("products")
        .document(str(uuid.uuid4()))
    )
    ref.set(
        {
            "boardroom": [{"speaker": speaker, "msg": line}],
            "outcome": {"name": "", "description": ""},
            "directive": directive,
            "weights": weights,
            "created": firestore.SERVER_TIMESTAMP,
            "updated": firestore.SERVER_TIMESTAMP,
        }
    )
    return ref.id


def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    company = body["company"]
    directive = body.get("directive", "Come up with the company’s first product")
    emps = load_employees(company)
    if not emps:
        return func.HttpResponse(json.dumps({"error": "no employees"}), status_code=400)
    weights = calc_weights(emps, directive)
    speaker = pick_first_speaker(emps, weights)
    line = gen_agent_line(speaker, [], directive)
    product_id = store_product(company, speaker["name"], line, directive, weights)
    return func.HttpResponse(
        json.dumps({"productId": product_id, "speaker": speaker["name"], "line": line}),
        mimetype="application/json",
    )
