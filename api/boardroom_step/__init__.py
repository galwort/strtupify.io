import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
import firebase_admin as fb
from openai import AzureOpenAI
from random import gauss
import json, datetime

vault = "https://kv-strtupifyio.vault.azure.net/"
sc = SecretClient(vault_url=vault, credential=DefaultAzureCredential())
endpoint = sc.get_secret("AIEndpoint").value
key = sc.get_secret("AIKey").value
deployment = sc.get_secret("AIDeploymentMini").value
client = AzureOpenAI(api_version="2023-07-01-preview", azure_endpoint=endpoint, api_key=key)

cred = credentials.Certificate(json.loads(sc.get_secret("FirebaseSDK").value))
if not fb._apps:
    initialize_app(cred)
db = firestore.client()


def load_product(company, product):
    ref = (
        db.collection("companies").document(company).collection("products").document(product)
    )
    doc = ref.get().to_dict()
    emps = [
        d.to_dict() | {"id": d.id}
        for d in db.collection("companies")
        .document(company)
        .collection("employees")
        .where("hired", "==", True)
        .stream()
    ]
    return ref, doc, emps


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


def choose_next_speaker(emps, history, weights):
    spoken = {}
    for h in history:
        spoken[h["speaker"]] = spoken.get(h["speaker"], 0) + 1
    return max(
        emps,
        key=lambda e: (weights.get(e["name"], 0.4) / (1 + spoken.get(e["name"], 0))) + gauss(0, 0.05),
    )


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


def gen_outcome(history):
    sys = "Return only JSON with keys 'name' and 'description' for the agreed product idea."
    msgs = [
        {"role": "system", "content": sys},
        {"role": "user", "content": "\n".join(f"{h['speaker']}: {h['msg']}" for h in history[-20:])},
    ]
    rsp = client.chat.completions.create(
        model=deployment, response_format={"type": "json_object"}, messages=msgs
    )
    data = json.loads(rsp.choices[0].message.content)
    return {"name": data.get("name", ""), "description": data.get("description", "")}


def append_line(ref, speaker, msg):
    ref.update(
        {
            "boardroom": firestore.ArrayUnion(
                [{"speaker": speaker, "msg": msg, "at": datetime.datetime.utcnow().isoformat()}]
            ),
            "updated": firestore.SERVER_TIMESTAMP,
        }
    )


def conversation_complete(outcome):
    return bool(outcome.get("name") and outcome.get("description"))


def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    company = body["company"]
    product = body["product"]
    ref, doc, emps = load_product(company, product)
    history = doc["boardroom"]
    directive = doc["directive"]
    weights = calc_weights(emps, directive)
    ref.update({"weights": weights})
    speaker = choose_next_speaker(emps, history, weights)
    line = gen_agent_line(speaker, history, directive)
    append_line(ref, speaker["name"], line)
    history.append({"speaker": speaker["name"], "msg": line})
    outcome = gen_outcome(history)
    ref.update({"outcome": outcome})
    done = conversation_complete(outcome)
    return func.HttpResponse(
        json.dumps({"speaker": speaker["name"], "line": line, "outcome": outcome, "done": done}),
        mimetype="application/json",
    )
