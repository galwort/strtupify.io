import json, datetime
from random import gauss
from tqdm import tqdm
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import AzureOpenAI

RUNS_PER_COMPANY = 5
ITERATIONS = 30
DIRECTIVE = (
    "This is the first meeting of a new startup. "
    "The goal is to come up with the first product or service that the company will offer. "
    "Reminder that this is the first meeting between the employees, "
    "so they don't know each other yet. "
)
STAGES = [
    {"name": "INTRODUCTIONS",     "minutes": 10, "goal": "everyone_spoke"},
    {"name": "BRAINSTORMING",     "minutes": 15, "goal": "idea_from_each"},
    {"name": "DECIDE ON A PRODUCT","minutes": 5,  "goal": "consensus"},
    {"name": "REFINEMENT",        "minutes": 10, "goal": "time_only"},
]

class StageClock:
    def __init__(self, emp_names):
        self.idx = 0
        self.elapsed = 0
        self.msgs_in_stage = 0
        self.emp_names = emp_names
        self.idea_owners = set() 

    @property
    def stage(self):
        return STAGES[self.idx]["name"]

    def tick(self):
        self.elapsed += 2
        self.msgs_in_stage += 1

    def goal_met(self, history, outcome):
        goal = STAGES[self.idx]["goal"]
        if goal == "everyone_spoke":
            return len({h["speaker"] for h in history}) >= len(emp_names)
        if goal == "idea_from_each":
            return all("idea" in h["msg"].lower() for h in history if h["speaker"] in emp_names)
        if goal == "consensus":
            return bool(outcome.get("product"))
        return False

    def advance_if_needed(self, history, outcome):
        if (self.elapsed >= sum(s["minutes"] for s in STAGES[:self.idx+1])
            or self.goal_met(history, outcome)):
            if self.idx < len(STAGES) - 1:
                self.idx += 1
                self.msgs_in_stage = 0


vault = "https://kv-strtupifyio.vault.azure.net/"
sc = SecretClient(vault_url=vault, credential=DefaultAzureCredential())
client = AzureOpenAI(
    api_version="2023-07-01-preview",
    azure_endpoint=sc.get_secret("AIEndpoint").value,
    api_key=sc.get_secret("AIKey").value,
    timeout=120,
    max_retries=6,
)
deployment = sc.get_secret("AIDeploymentMini").value


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
    w = {k: max(0, min(1, float(v))) for k, v in raw.items() if isinstance(v, (int, float, str))}
    if len(set(w.values())) <= 1:
        for e in emps:
            w[e["name"]] = max(0, min(1, gauss(0.5, 0.15)))
    return w


def pick_first_speaker(emps, weights):
    return max(emps, key=lambda e: weights.get(e["name"], 0.4) + gauss(0, 0.05))


def choose_next_speaker(emps, history, weights):
    spoken = {}
    for h in history:
        spoken[h["speaker"]] = spoken.get(h["speaker"], 0) + 1
    return max(
        emps,
        key=lambda e: (weights.get(e["name"], 0.4) / (1 + spoken.get(e["name"], 0)))
        + gauss(0, 0.05),
    )


def gen_agent_line(agent, history, directive, company, company_description, counter, stage):
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
    if history:
        for h in history:
            msgs.append({"role": "assistant", "content": f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role": "user", "content": f"{agent['name']}:"})
    rsp = client.chat.completions.create(model=deployment, messages=msgs)
    content = rsp.choices[0].message.content or ""
    if content.startswith(agent["name"]):
        content = content[len(agent["name"]) + 1 :]
    if content.startswith(agent["name"].split()[0]):
        content = content[len(agent["name"].split()[0]) + 1 :]
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


def conversation_complete(outcome):
    return bool(outcome.get("product") and outcome.get("description"))


with open("input.json") as f:
    companies = json.load(f)

results = []
total_runs = len(companies) * RUNS_PER_COMPANY

with tqdm(total=total_runs, desc="Boardroom sims") as pbar:
    for c in companies:
        for _ in range(RUNS_PER_COMPANY):
            emps = c["employees"]
            emp_names = [e["name"] for e in emps]
            clock = StageClock(emp_names)
            company = c["company"]["name"]
            company_description = c["company"]["description"]
            history = []
            weights = calc_weights(emps, DIRECTIVE, "")
            speaker = pick_first_speaker(emps, weights)
            line = gen_agent_line(speaker, history, DIRECTIVE, company, company_description, 0, clock.stage)
            history.append(
                {
                    "speaker": speaker["name"],
                    "msg": line,
                    "weights": weights,
                    "stage": clock.stage,
                    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
            )
            outcome = {}
            for _ in range(ITERATIONS - 1):
                counter = len(history)
                recent = "\n".join(f"{h['speaker']}: {h['msg']}" for h in history)
                weights = calc_weights(emps, DIRECTIVE, recent)
                speaker = choose_next_speaker(emps, history, weights)
                line = gen_agent_line(speaker, history, DIRECTIVE, company, company_description, counter, clock.stage)
                history.append(
                    {
                        "speaker": speaker["name"],
                        "msg": line,
                        "weights": weights,
                        "stage": clock.stage,
                        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    }
                )
                if clock.stage == "DECIDE ON A PRODUCT":
                    outcome = gen_outcome(history, emp_names)
                clock.tick()
                clock.advance_if_needed(history, outcome)
                if clock.stage == "REFINEMENT" and clock.elapsed >= 40:
                    break
                if conversation_complete(outcome):
                    break
            results.append(
                {
                    "company": c["company"],
                    "boardroom": history,
                    "product": outcome.get("product", ""),
                    "description": outcome.get("description", ""),
                }
            )
            pbar.update(1)

with open("output.json", "w") as f:
    json.dump(results, f, indent=2)