import json, datetime, uuid
from random import gauss
from tqdm import tqdm  
from azure.identity import DefaultAzureCredential  
from azure.keyvault.secrets import SecretClient
from openai import AzureOpenAI  

vault = "https://kv-strtupifyio.vault.azure.net/"
sc = SecretClient(vault_url=vault, credential=DefaultAzureCredential())
client = AzureOpenAI(
    api_version="2023-07-01-preview",
    azure_endpoint=sc.get_secret("AIEndpoint").value,
    api_key=sc.get_secret("AIKey").value,
)
deployment = sc.get_secret("AIDeploymentMini").value

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
    w = {}
    for k, v in raw.items():
        try:
            w[k] = max(0, min(1, float(v)))
        except:
            continue
    if not w:
        for e in emps:
            w[e["name"]] = 0.5
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

def gen_agent_line(agent, history, directive):
    sys = (
        f"You are {agent['name']}, a {agent['title']} at a brand-new startup. Personality: {agent['personality']}. "
        f"Keep your sentences concise. Meeting goal: {directive}. Begin EXACTLY one sentence."
    )
    msgs = [{"role": "system", "content": sys}]
    if history:
        for h in history[-6:]:
            msgs.append({"role": "assistant", "content": f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role": "assistant", "content": f"{agent['name']}:"})
    rsp = client.chat.completions.create(model=deployment, messages=msgs)
    return rsp.choices[0].message.content.strip()

def gen_outcome(history):
    sys = "Return only JSON with keys 'product' and 'description' for the agreed idea."
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

directive = "Come up with the company’s first product"
iterations = 5

with open("input.json") as f:
    companies = json.load(f)

results = []
for c in tqdm(companies, desc="Companies"):
    emps = c["employees"]
    history = []
    weights = calc_weights(emps, directive)
    speaker = pick_first_speaker(emps, weights)
    line = gen_agent_line(speaker, history, directive)
    history.append(
        {
            "speaker": speaker["name"],
            "msg": line,
            "weights": weights,
            "at": datetime.datetime.utcnow().isoformat(),
        }
    )
    outcome = {}
    for _ in range(iterations - 1):
        weights = calc_weights(emps, directive)
        speaker = choose_next_speaker(emps, history, weights)
        line = gen_agent_line(speaker, history, directive)
        history.append(
            {
                "speaker": speaker["name"],
                "msg": line,
                "weights": weights,
                "at": datetime.datetime.utcnow().isoformat(),
            }
        )
        outcome = gen_outcome(history)
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

with open("output.json", "w") as f:
    json.dump(results, f, indent=2)