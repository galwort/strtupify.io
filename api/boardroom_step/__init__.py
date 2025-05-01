import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
import firebase_admin as fb, json, datetime
from openai import AzureOpenAI
from random import gauss

DIRECTIVE = (
    "This is the first meeting of a new startup. "
    "The goal is to come up with the first product or service that the company will offer. "
    "Reminder that this is the first meeting between the employees, "
    "so they don't know each other yet. "
)

STAGES = [
    {"name": "INTRODUCTIONS",      "minutes": 10, "goal": "everyone_spoke"},
    {"name": "BRAINSTORMING",      "minutes": 15, "goal": "idea_from_each"},
    {"name": "DECIDE ON A PRODUCT","minutes": 5,  "goal": "consensus"},
    {"name": "REFINEMENT",         "minutes": 10, "goal": "time_only"},
]

class StageClock:
    def __init__(self, idx=0, elapsed=0):
        self.idx = idx
        self.elapsed = elapsed

    @property
    def stage(self):
        return STAGES[self.idx]["name"]

    def tick(self):
        self.elapsed += 2

    def goal_met(self, hist, outcome, emp_names):
        goal = STAGES[self.idx]["goal"]
        if goal == "everyone_spoke":
            return len({h["speaker"] for h in hist}) >= len(emp_names)
        if goal == "idea_from_each":
            return all("idea" in h["msg"].lower() for h in hist if h["speaker"] in emp_names)
        if goal == "consensus":
            return bool(outcome.get("product"))
        return False

    def advance(self, hist, outcome, emp_names):
        if self.elapsed >= STAGES[self.idx]["minutes"] or self.goal_met(hist, outcome, emp_names):
            if self.idx < len(STAGES) - 1:
                self.idx += 1


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


def load_state(company, product):
    ref = db.collection("companies").document(company).collection("products").document(product)
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


def load_company_description(company):
    doc = db.collection("companies").document(company).get().to_dict() or {}
    return doc.get("description", "")

def calc_weights(emps, directive, recent_lines):
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
            "recent_dialogue": recent_lines,
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
    weights = {k: max(0, min(1, float(v))) for k, v in raw.items() if isinstance(v, (int, float, str))}
    if len(set(weights.values())) <= 1:
        for e in emps:
            weights[e["name"]] = max(0, min(1, gauss(0.5, 0.15)))
    return weights


def choose_next_speaker(emps, history, weights):
    spoken = {}
    for h in history:
        spoken[h["speaker"]] = spoken.get(h["speaker"], 0) + 1
    return max(
        emps,
        key=lambda e: (weights.get(e["name"], 0.4) / (1 + spoken.get(e["name"], 0)))
        + gauss(0, 0.05),
    )


def gen_agent_line(agent, history, directive, company, company_description, counter, stage, emp_names):
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
        f"So far, {counter*2} minutes have passed in the meeting, "
        f"which means you are in the {stage} stage of the meeting. "
    )
    msgs = [{"role": "system", "content": sys}]
    for h in history:
        msgs.append({"role": "assistant", "content": f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role": "user", "content": f"{agent['name']}:"})
    rsp = client.chat.completions.create(model=deployment, messages=msgs)
    content = rsp.choices[0].message.content or ""
    for name in emp_names:
        low = name.lower()
        first = name.split()[0].lower()
        if content.lower().startswith(low):
            content = content[len(name):].lstrip(":,.- ").strip()
            break
        if content.lower().startswith(first):
            content = content[len(first):].lstrip(":,.- ").strip()
            break
    return content.strip()


def gen_outcome(history, emp_names):
    sys = (
        "You are an impartial meeting observer. "
        "If the conversation shows that all participants have clearly agreed on a single, specific product or service idea, "
        "return a JSON object with keys 'product' and 'description' describing that idea. "
        f"This meeting, in total, has {len(emp_names)} participants: {', '.join(emp_names)}. "
        "At least two thirds of the participants must have clearly expressed support—e.g. phrases like "
        "\"I agree\", \"Yes, that works\", \"Let's build X\", \"Sounds good to me\". "
        "Otherwise return {\"product\":\"\", \"description\":\"\"}. "
    )
    msgs = [
        {"role": "system", "content": sys},
        {"role": "user", "content": "\n".join(f"{h['speaker']}: {h['msg']}" for h in history)},
    ]
    rsp = client.chat.completions.create(
        model=deployment, response_format={"type": "json_object"}, messages=msgs
    )
    return json.loads(rsp.choices[0].message.content)


def append_line(ref, speaker, msg, weights, stage):
    ref.update(
        {
            "boardroom": firestore.ArrayUnion(
                [
                    {
                        "speaker": speaker,
                        "msg": msg,
                        "weights": weights,
                        "stage": stage,
                        "at": datetime.datetime.utcnow().isoformat(),
                    }
                ]
            ),
            "stage": stage,
            "updated": firestore.SERVER_TIMESTAMP,
        }
    )


def conversation_complete(state):
    return bool(state.get("product") and state.get("description"))


def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    company = body["company"]
    product = body["product"]
    ref, doc, emps = load_state(company, product)
    if doc is None:
        return func.HttpResponse(json.dumps({"error": "product not found"}), status_code=404)
    if not emps:
        return func.HttpResponse(json.dumps({"error": "no employees"}), status_code=404)

    emp_names = [e["name"] for e in emps]
    raw_stage = doc.get("stage", "INTRODUCTIONS")
    if isinstance(raw_stage, int):
        raw_stage = STAGES[min(raw_stage, len(STAGES) - 1)]["name"]
    if raw_stage not in {s["name"] for s in STAGES}:
        raw_stage = "INTRODUCTIONS"

    clock = StageClock(
        idx=next(i for i, s in enumerate(STAGES) if s["name"] == raw_stage),
        elapsed=doc.get("elapsed", 0),
    )

    history = doc.get("boardroom", [])
    outcome = {}
    recent = "\n".join(f"{h['speaker']}: {h['msg']}" for h in history)
    weights = calc_weights(emps, DIRECTIVE, recent)
    speaker = choose_next_speaker(emps, history, weights)
    line = gen_agent_line(
        speaker,
        history,
        DIRECTIVE,
        company,
        load_company_description(company),
        len(history),
        clock.stage,
        emp_names,
    )
    history.append({"speaker": speaker["name"], "msg": line})
    if clock.stage == "DECIDE ON A PRODUCT":
        outcome = gen_outcome(history, emp_names)
    clock.tick()
    clock.advance(history, outcome, emp_names)
    append_line(ref, speaker["name"], line, weights, clock.stage)
    ref.update({"elapsed": clock.elapsed, **outcome})
    return func.HttpResponse(
        json.dumps(
            {
                "speaker": speaker["name"],
                "line": line,
                "outcome": outcome,
                "done": conversation_complete(outcome),
                "stage": clock.stage,
            }
        ),
        mimetype="application/json",
    )
