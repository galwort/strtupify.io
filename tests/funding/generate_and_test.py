import argparse, json, datetime, time
from typing import List, Dict
import requests
from tqdm import tqdm
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import AzureOpenAI


def make_client():
    vault = "https://kv-strtupifyio.vault.azure.net/"
    sc = SecretClient(vault_url=vault, credential=DefaultAzureCredential())
    endpoint = sc.get_secret("AIEndpoint").value
    key = sc.get_secret("AIKey").value
    dep = sc.get_secret("AIDeploymentMini").value
    client = AzureOpenAI(
        api_version="2023-07-01-preview",
        azure_endpoint=endpoint,
        api_key=key,
        timeout=60,
        max_retries=6,
    )
    return client, dep


def _extract_name_desc(obj: Dict) -> Dict:
    if not isinstance(obj, dict):
        return {"name": "", "description": ""}
    candidates = [obj]
    for key in ["scenario", "company", "result", "data"]:
        if isinstance(obj.get(key), dict):
            candidates.append(obj[key])
    name_keys = ["name", "company_name", "company", "startup", "title"]
    desc_keys = [
        "description",
        "desc",
        "summary",
        "company_description",
        "scenario_description",
    ]
    name = ""
    desc = ""
    for c in candidates:
        for k in name_keys:
            v = c.get(k)
            if isinstance(v, str) and v.strip():
                name = v.strip().strip('"').strip()
                break
        if name:
            break
    for c in candidates:
        for k in desc_keys:
            v = c.get(k)
            if isinstance(v, str) and v.strip():
                desc = v.strip()
                break
        if desc:
            break
    return {"name": name, "description": desc}


def gen_scenario(client: AzureOpenAI, deployment: str, used_names: List[str]) -> Dict:
    sys = (
        "You generate realistic startup loan application scenarios. "
        "Each scenario must include a concise company name and a 2-4 sentence description. "
        "Vary industries, traction, regulation, capital intensity, and business models. "
        "Favor concrete, plausible details over hype. "
        "Return JSON with keys: name, description."
    )
    user = json.dumps(
        {
            "avoid_names": used_names[-25:],
            "constraints": [
                "mix consumer, B2B, deeptech, services",
                "include both capital-light and capital-heavy ideas",
                "some regulated markets (fintech/health), some unregulated",
                "mix pre-revenue and early traction",
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
    raw = rsp.choices[0].message.content
    try:
        data = json.loads(raw)
    except Exception:
        data = {"name": "", "description": ""}
    ex = _extract_name_desc(data)
    if len(ex["name"]) < 2 or len(ex["description"]) < 20:
        rsp2 = client.chat.completions.create(
            model=deployment,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": "Return JSON with keys: name, description. No prose.",
                },
                {
                    "role": "user",
                    "content": "Generate a realistic startup loan application scenario with a concise company name and a 2-4 sentence description.",
                },
            ],
        )
        try:
            data2 = json.loads(rsp2.choices[0].message.content)
        except Exception:
            data2 = {}
        ex = _extract_name_desc(data2)
    name = ex["name"][:80]
    desc = ex["description"]
    return {"name": name, "description": desc}


def fallback_scenario(idx: int) -> Dict:
    inds = [
        ("fintech", "A mobile app offering automated round-up savings with FDIC-insured partner banks."),
        ("healthtech", "A HIPAA-compliant telehealth triage tool for urgent care clinics to reduce wait times."),
        ("climate", "Modular solar pergolas for small businesses with no-upfront-cost PPAs."),
        ("SaaS B2B", "Workflow automation for property managers syncing maintenance requests to vendors."),
        ("consumer", "A subscription snack box tailored by real-time allergen scanning."),
        ("robotics", "Low-cost shelf-scanning robots for independent grocery stores."),
        ("hardware", "Compact CNC machines for school maker labs with cloud lesson plans."),
        ("AI devtools", "Test data synthesis for QA teams using privacy-preserving LLMs."),
        ("logistics", "Dynamic route planning for same-day couriers in mid-sized cities."),
        ("edtech", "Micro-courses for trades with employer-backed placement partners."),
    ]
    i = idx % len(inds)
    name = f"{inds[i][0].capitalize()} Labs {1000 + idx}"
    desc = (
        f"{inds[i][1]} Targets SMBs with a pilot in 3 cities. "
        f"Seed capital funds MVP and first 6 months of go-to-market."
    )
    return {"name": name, "description": desc}


def call_funding(url: str, description: str) -> Dict:
    r = requests.post(url, json={"company_description": description}, timeout=60)
    if r.status_code != 200:
        return {"error": f"status {r.status_code}", "body": r.text}
    try:
        return r.json()
    except Exception as e:
        return {"error": str(e), "body": r.text}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--count", type=int, default=25)
    p.add_argument("--outfile", type=str, default="output.json")
    p.add_argument(
        "--url",
        type=str,
        default="https://fa-strtupifyio.azurewebsites.net/api/funding",
    )
    args = p.parse_args()

    client, dep = make_client()
    used = []
    results = []

    with tqdm(total=args.count, desc="Funding scenarios") as bar:
        for _ in range(args.count):
            attempts = 0
            scenario = {"name": "", "description": ""}
            while attempts < 3 and (len(scenario["name"]) < 2 or len(scenario["description"]) < 20):
                scenario = gen_scenario(client, dep, used)
                attempts += 1
            name, desc = scenario["name"], scenario["description"]
            if not name or len(desc) < 20:
                fb = fallback_scenario(len(used) + 1)
                name = name or fb["name"]
                desc = desc if len(desc) >= 20 else fb["description"]
            used.append(name)
            funding = call_funding(args.url, desc)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            results.append(
                {
                    "company": {"name": name, "description": desc},
                    "funding": funding,
                    "at": now,
                }
            )
            bar.update(1)
            time.sleep(0.5)

    with open(args.outfile, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
