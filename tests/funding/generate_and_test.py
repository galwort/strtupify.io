import argparse, json, datetime, time, random
from typing import List, Dict
import re
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
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
    emb = sc.get_secret("AIDeploymentEmbedding").value
    client = AzureOpenAI(
        api_version="2023-07-01-preview",
        azure_endpoint=endpoint,
        api_key=key,
        timeout=60,
        max_retries=6,
    )
    return client, dep, emb


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


def gen_scenario(client: AzureOpenAI, deployment: str, used_names: List[str], profile: Dict, required_terms: List[str], avoid_terms: List[str]) -> Dict:
    sys = (
        "You generate realistic startup loan application scenarios. "
        "Each scenario must include a concise company name and a 2-4 sentence description. "
        "Favor concrete, plausible details over hype. "
        "Strictly follow the provided target profile attributes. "
        "Return JSON with keys: name, description."
    )
    user = json.dumps(
        {
            "avoid_names": used_names[-25:],
            "target_profile": profile,
            "required_terms": required_terms,
            "avoid_terms": avoid_terms,
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
                    "content": json.dumps(
                        {
                            "instruction": "Generate a realistic startup loan application scenario with a concise company name and a 2-4 sentence description.",
                            "target_profile": profile,
                            "required_terms": required_terms,
                            "avoid_terms": avoid_terms,
                        }
                    ),
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
        ("SaaS B2B", "Workflow automation for property managers syncing maintenance requests to vendors."),
        ("consumer", "A subscription snack box tailored by real-time allergen scanning."),
        ("robotics", "Low-cost shelf-scanning robots for independent grocery stores."),
        ("hardware", "Compact CNC machines for school maker labs with cloud lesson plans."),
        ("AI devtools", "Test data synthesis for QA teams using privacy-preserving LLMs."),
        ("logistics", "Dynamic route planning for same-day couriers in mid-sized cities."),
        ("edtech", "Micro-courses for trades with employer-backed placement partners."),
        ("legaltech", "Automated intake and calendaring for small law firms with e-filing integrations."),
        ("proptech", "Tenant screening and rent reporting that builds credit for renters while reducing defaults."),
        ("agtech", "IoT soil sensors and irrigation controls for water savings in orchards."),
        ("security", "Continuous cloud posture scanning for SME Kubernetes clusters."),
        ("ecommerce", "On-site product video generation and A/B testing for Shopify brands."),
        ("creator", "Licensing marketplace for short-form music loops with revenue share."),
        ("hospitality", "Dynamic pricing and staff scheduling for independent boutique hotels."),
        ("supply chain", "Purchase order risk scoring with EDI integrations for mid-market manufacturers."),
        ("energy", "Virtual power plant software for community battery programs."),
        ("govtech", "Case management lightweight CRM for municipal public works requests."),
    ]
    i = idx % len(inds)
    name = f"{inds[i][0].capitalize()} Labs {1000 + idx}"
    desc = (
        f"{inds[i][1]} Targets SMBs with a pilot in 3 cities. "
        f"Seed capital funds MVP and first 6 months of go-to-market."
    )
    return {"name": name, "description": desc}


def cosine_sim(a: List[float], b: List[float]) -> float:
    num = 0.0
    da = 0.0
    db = 0.0
    for x, y in zip(a, b):
        num += x * y
        da += x * x
        db += y * y
    if da == 0 or db == 0:
        return 0.0
    import math

    return num / (math.sqrt(da) * math.sqrt(db))


def embed(client: AzureOpenAI, embed_model: str, text: str) -> List[float]:
    rsp = client.embeddings.create(model=embed_model, input=text or "")
    return rsp.data[0].embedding


def tokenize_name(s: str) -> List[str]:
    s = s.lower()
    toks = re.split(r"[^a-z0-9]+", s)
    stop = {"inc", "labs", "co", "corp", "solutions", "systems", "technologies", "tech", "the"}
    return [t for t in toks if t and t not in stop]


def name_too_similar(name: str, used: List[str]) -> bool:
    a = set(tokenize_name(name))
    if not a:
        return False
    for u in used:
        b = set(tokenize_name(u))
        inter = len(a & b)
        union = len(a | b) or 1
        j = inter / union
        if j >= 0.6:
            return True
    return False


INDUSTRY_ANCHORS = {
    "fintech": ["payments", "KYC", "ledger", "banking"],
    "healthtech": ["HIPAA", "clinics", "patients", "EHR"],
    "SaaS B2B": ["SaaS", "workflow", "automation", "API"],
    "consumer": ["consumer", "mobile app", "subscription"],
    "robotics": ["robot", "automation", "sensors"],
    "hardware": ["device", "manufacturing", "PCB"],
    "AI devtools": ["LLM", "testing", "dev", "SDK"],
    "logistics": ["routing", "courier", "dispatch"],
    "edtech": ["course", "learning", "schools"],
    "legaltech": ["intake", "docket", "paralegal"],
    "proptech": ["tenant", "lease", "rent"],
    "agtech": ["irrigation", "soil", "yield"],
    "security": ["security", "vulnerability", "cloud"],
    "ecommerce": ["Shopify", "conversion", "merchants"],
    "creator": ["creator", "music", "licensing"],
    "hospitality": ["hotel", "occupancy", "booking"],
    "supply chain": ["purchase order", "EDI", "supplier"],
    "energy": ["grid", "battery", "solar"],
    "govtech": ["municipal", "permits", "public works"],
}


def satisfies_anchors(desc: str, anchors: List[str]) -> bool:
    d = desc.lower()
    return any(a.lower() in d for a in anchors) if anchors else True


def sample_profile(used_profiles: set, attempt: int) -> Dict:
    import random

    industries = [
        "fintech",
        "healthtech",
        "climate",
        "SaaS B2B",
        "consumer",
        "robotics",
        "hardware",
        "AI devtools",
        "logistics",
        "edtech",
        "legaltech",
        "govtech",
        "proptech",
        "agtech",
        "biotech",
        "gaming",
        "security",
        "ecommerce",
        "creator",
        "hospitality",
    ]
    cap = ["low", "medium", "high"]
    reg = ["regulated", "unregulated"]
    model = [
        "B2B subscription",
        "B2C subscription",
        "Marketplace",
        "Transaction fee",
        "Hardware + service",
        "Usage-based API",
        "Services",
    ]
    traction = [
        "pre-revenue",
        "pilot customers",
        "$10k MRR",
        "$50k MRR",
        "waitlist 10k",
    ]
    geo = [
        "US metro",
        "EU market",
        "LATAM",
        "India",
        "SEA",
        "MENA",
        "Sub-Saharan Africa",
        "rural US",
        "Canada",
        "UK",
    ]

    for _ in range(50):
        prof = {
            "industry": random.choice(industries),
            "capital_intensity": random.choice(cap),
            "regulated": random.choice(reg),
            "business_model": random.choice(model),
            "traction": random.choice(traction),
            "geography": random.choice(geo),
        }
        key = tuple(prof.values())
        if key not in used_profiles:
            used_profiles.add(key)
            return prof
    return prof


def create_session(http_retries: int, backoff: float) -> requests.Session:
    retry = Retry(
        total=http_retries,
        connect=http_retries,
        read=http_retries,
        status=http_retries,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods={"POST", "GET"},
        backoff_factor=backoff,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    s = requests.Session()
    s.mount("http://", adapter)
    s.mount("https://", adapter)
    return s


def call_funding(session: requests.Session, url: str, description: str, timeout: float, attempts: int, base_backoff: float) -> Dict:
    headers = {"Connection": "close"}
    err: Dict = {"error": "unknown"}
    for i in range(attempts):
        try:
            r = session.post(url, json={"company_description": description}, timeout=timeout, headers=headers)
            if r.status_code == 200:
                try:
                    return r.json()
                except Exception as e:
                    return {"error": str(e), "body": r.text}
            else:
                err = {"error": f"status {r.status_code}", "body": r.text}
        except requests.RequestException as e:
            err = {"error": f"request_exception: {e.__class__.__name__}: {e}"}
        sleep = (base_backoff * (2 ** i)) + random.uniform(0, 0.25)
        time.sleep(min(sleep, 8.0))
    return err


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--count", type=int, default=25)
    p.add_argument("--outfile", type=str, default="output.json")
    p.add_argument(
        "--url",
        type=str,
        default="https://fa-strtupifyio.azurewebsites.net/api/funding",
    )
    p.add_argument("--diversity", type=float, default=0.85, help="Max cosine similarity allowed between descriptions")
    p.add_argument("--max-tries", type=int, default=5, help="Max attempts per scenario to satisfy diversity")
    p.add_argument(
        "--avoid-terms",
        type=str,
        default="eco,pack,packaging,sustainable,biodegradable,compostable,eco-friendly",
    )
    p.add_argument("--sleep", type=float, default=0.5, help="Base sleep between scenarios")
    p.add_argument("--http-retries", type=int, default=6, help="HTTP adapter retry budget for funding calls")
    p.add_argument("--http-timeout", type=float, default=60.0, help="HTTP timeout seconds for funding calls")
    p.add_argument("--http-attempts", type=int, default=6, help="Outer attempts for connection reset recovery")
    p.add_argument("--http-backoff", type=float, default=0.75, help="Exponential backoff factor for retries")
    args = p.parse_args()

    client, dep, emb = make_client()
    used = []
    results = []
    used_profiles = set()
    prev_embeds: List[List[float]] = []
    avoid_terms = [t.strip() for t in args.avoid_terms.split(",") if t.strip()]
    session = create_session(args.http_retries, args.http_backoff)

    with tqdm(total=args.count, desc="Funding scenarios") as bar:
        for _ in range(args.count):
            attempts = 0
            scenario = {"name": "", "description": ""}
            profile = sample_profile(used_profiles, _)
            anchors = INDUSTRY_ANCHORS.get(profile.get("industry"), [])
            while attempts < args.max_tries:
                scenario = gen_scenario(client, dep, used, profile, anchors, avoid_terms)
                if len(scenario["name"]) >= 2 and len(scenario["description"]) >= 20:
                    if anchors and not satisfies_anchors(scenario["description"], anchors):
                        attempts += 1
                        continue
                    if name_too_similar(scenario["name"], used):
                        attempts += 1
                        continue
                    try:
                        emb_vec = embed(client, emb, scenario["description"])  # type: ignore
                        sim = max((cosine_sim(emb_vec, e) for e in prev_embeds), default=0.0)
                        if sim <= args.diversity:
                            prev_embeds.append(emb_vec)
                            break
                    except Exception:
                        break
                attempts += 1
            name, desc = scenario["name"], scenario["description"]
            if not name or len(desc) < 20:
                fb = fallback_scenario(len(used) + 1)
                name = name or fb["name"]
                desc = desc if len(desc) >= 20 else fb["description"]
            used.append(name)
            funding = call_funding(session, args.url, desc, args.http_timeout, args.http_attempts, args.http_backoff)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            results.append(
                {
                    "company": {"name": name, "description": desc},
                    "profile": profile,
                    "funding": funding,
                    "at": now,
                }
            )
            try:
                with open(args.outfile + ".tmp", "w", encoding="utf-8") as tf:
                    json.dump(results, tf, indent=2, ensure_ascii=False)
            except Exception:
                pass
            bar.update(1)
            time.sleep(max(0.0, args.sleep))

    with open(args.outfile, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
