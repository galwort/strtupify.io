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

vault = "https://kv-strtupifyio.vault.azure.net/"
sc = SecretClient(vault_url=vault, credential=DefaultAzureCredential())
client = AzureOpenAI(
    api_version="2023-07-01-preview",
    azure_endpoint=sc.get_secret("AIEndpoint").value,
    api_key=sc.get_secret("AIKey").value,
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


def gen_agent_line(agent, history, directive, company, company_description, counter):
    sys = (
        f"You are {agent['name']}, a {agent['title']} at a new startup. "
        f"Company: {company}. Company description: {company_description}. "
        f"Personality: {agent['personality']}. Meeting goal: {directive} "
        f"You should respond naturally as if you are in a real meeting. "
        f"Sometimes you may question, disagree, or express doubts about what was said before you. "
        f"Your response should still feel collaborative but not always perfectly aligned. "
        f"Respond with a single natural-sounding line of dialogue."
        f"So far, {counter} minutes have passed in the meeting. "
    )
    msgs = [{"role": "system", "content": sys}]
    if history:
        for h in history[-10:]:
            msgs.append({"role": "assistant", "content": f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role": "user", "content": f"{agent['name']}:"})
    rsp = client.chat.completions.create(model=deployment, messages=msgs)
    content = rsp.choices[0].message.content or ""
    return content.strip()


def gen_outcome(history, emp_names):
    sys = (
        "You are an impartial meeting observer. "
        "If the conversation shows that all participants have clearly agreed on a single, specific product or service idea, "
        "return a JSON object with keys 'product' and 'description' describing that idea. "
        "Return {\"product\":\"\",\"description\":\"\"} unless EVERY participant "
        "has clearly and explicitly agreed (e.g. said “I agree” or “Yes, let’s do X”) "
        "on one single, specific product/service. "
        f"This meeting has {len(emps)} participants: "
        f"{', '.join(emp_names)}. "
        "Each of these people have to agree on the product or service idea. "
    )
    msgs = [
        {"role": "system", "content": sys},
        {"role": "user", "content": "\n".join(f"{h['speaker']}: {h['msg']}" for h in history[-20:])},
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
            company = c["company"]["name"]
            company_description = c["company"]["description"]
            emps = c["employees"]
            emp_names = [e["name"] for e in emps]
            history = []
            weights = calc_weights(emps, DIRECTIVE, "")
            speaker = pick_first_speaker(emps, weights)
            line = gen_agent_line(speaker, history, DIRECTIVE, company, company_description, 0)
            history.append(
                {
                    "speaker": speaker["name"],
                    "msg": line,
                    "weights": weights,
                    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
            )
            outcome = {}
            for _ in range(ITERATIONS - 1):
                counter = len(history)
                recent = "\n".join(f"{h['speaker']}: {h['msg']}" for h in history[-3:])
                weights = calc_weights(emps, DIRECTIVE, recent)
                speaker = choose_next_speaker(emps, history, weights)
                line = gen_agent_line(speaker, history, DIRECTIVE, company, company_description, counter)
                history.append(
                    {
                        "speaker": speaker["name"],
                        "msg": line,
                        "weights": weights,
                        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    }
                )
                outcome = gen_outcome(history, emp_names)
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
