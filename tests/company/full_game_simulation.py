"""End-to-end simulation test harness for Strtupify game components.

This script stitches together the core Azure-backed behaviours that power
Strtupify's funding, hiring, boardroom, and work planning flows.  It mirrors the
existing Azure Function logic but runs everything locally so tests can exercise
an entire company lifecycle.

Usage (example):
    python tests/company/full_game_simulation.py --count 3 --outfile tests/company/run.json

The script produces a JSON document capturing the generated companies,
employees, work items, and computed schedule metrics.  A companion evaluation
script consumes this JSON to report aggregate statistics.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import requests
from requests.adapters import HTTPAdapter
from tqdm import tqdm
from urllib3.util.retry import Retry

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import AzureOpenAI

# ---------------------------------------------------------------------------
# Section: Shared Azure OpenAI helpers (mirrors tests/funding/generate_and_test)
# ---------------------------------------------------------------------------


def make_client() -> Tuple[AzureOpenAI, str, str]:
    """Instantiate an Azure OpenAI chat + embedding client pair."""

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


def gen_scenario(
    client: AzureOpenAI,
    deployment: str,
    used_names: Sequence[str],
    profile: Dict,
    required_terms: Sequence[str],
    avoid_terms: Sequence[str],
) -> Dict:
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


def cosine_sim(a: Sequence[float], b: Sequence[float]) -> float:
    num = 0.0
    da = 0.0
    db = 0.0
    for x, y in zip(a, b):
        num += x * y
        da += x * x
        db += y * y
    if da == 0 or db == 0:
        return 0.0
    return num / (math.sqrt(da) * math.sqrt(db))


def embed(client: AzureOpenAI, embed_model: str, text: str) -> List[float]:
    rsp = client.embeddings.create(model=embed_model, input=text or "")
    return rsp.data[0].embedding


def tokenize_name(s: str) -> List[str]:
    s = s.lower()
    toks = [t for t in ''.join(c if c.isalnum() else ' ' for c in s).split() if t]
    stop = {"inc", "labs", "co", "corp", "solutions", "systems", "technologies", "tech", "the"}
    return [t for t in toks if t and t not in stop]


def name_too_similar(name: str, used: Sequence[str]) -> bool:
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


def satisfies_anchors(desc: str, anchors: Sequence[str]) -> bool:
    d = desc.lower()
    return any(a.lower() in d for a in anchors) if anchors else True


def sample_profile(used_profiles: set[Tuple[str, ...]], attempt: int) -> Dict:
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
        "USD 10k MRR",
        "USD 50k MRR",
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


def call_funding(
    session: requests.Session,
    url: str,
    description: str,
    timeout: float,
    attempts: int,
    base_backoff: float,
) -> Dict:
    headers = {"Connection": "close"}
    err: Dict = {"error": "unknown"}
    for i in range(attempts):
        try:
            r = session.post(
                url,
                json={"company_description": description},
                timeout=timeout,
                headers=headers,
            )
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

# ---------------------------------------------------------------------------
# Section: Role, skill, resume generation helpers (mirrors api/jobs & api/skills)
# ---------------------------------------------------------------------------


def gen_jobs(client: AzureOpenAI, deployment: str, company_description: str) -> List[str]:
    system_message = (
        "You are a hiring planner for an early-stage startup. "
        "Given a company description, return a JSON object with a 'jobs' array of no more than 8 role titles the company should hire for. "
        "Favor a cross-functional mix spanning various departments as appropriate for the company's focus. "
        "If the description is vague or incomplete, infer a plausible set of roles for a typical early-stage product company rather than returning an empty list. "
        "Only return an empty list when the description clearly states no hiring is needed. "
        "Keep titles concise and reply in strict JSON with key 'jobs' (list of strings). "
        "If there is a hard error parsing the input, include an 'error' key and set 'jobs' to an empty list."
    )

    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": company_description},
        ],
    )
    try:
        payload = json.loads(rsp.choices[0].message.content)
    except Exception:
        return []
    if isinstance(payload, dict) and isinstance(payload.get("jobs"), list):
        return [str(j).strip() for j in payload["jobs"] if str(j).strip()]
    return []


def gen_skills(client: AzureOpenAI, deployment: str, job_title: str) -> List[str]:
    system_message = (
        "You are a job skills generator. When given the title of a job, "
        "reply with a JSON object {'skills': [...] } containing no more than 5 concise, proper-case skill names appropriate for that job."
    )
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": job_title},
        ],
    )
    try:
        payload = json.loads(rsp.choices[0].message.content)
        skills = payload.get("skills") or []
        return [str(s).strip() for s in skills if str(s).strip()]
    except Exception:
        return []


def gen_personality(client: AzureOpenAI, deployment: str, name: str) -> str:
    system_message = (
        "You are a personality generator. When given a person's name, reply with JSON {'personality': 'short description'} describing their professional demeanor."
    )
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": name},
        ],
    )
    try:
        return json.loads(rsp.choices[0].message.content)["personality"]
    except Exception:
        return "Calm and collaborative team contributor."


def gen_salary(client: AzureOpenAI, deployment: str, job_title: str, skills: List[Dict]) -> int:
    system_message = (
        "You are a salary generator. When given a job title and skill-level list (1-10 scale), return JSON {'salary': int} representing an annual USD salary."
    )
    payload = json.dumps({"job_title": job_title, "skills": skills})
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": payload},
        ],
    )
    try:
        return int(json.loads(rsp.choices[0].message.content)["salary"])
    except Exception:
        base = 90_000 + random.randint(-8000, 12000)
        return max(55_000, base)


def random_name() -> str:
    first = [
        "Alex",
        "Jordan",
        "Taylor",
        "Casey",
        "Morgan",
        "Quinn",
        "Jamie",
        "Riley",
        "Cameron",
        "Avery",
        "Dakota",
        "Emerson",
    ]
    last = [
        "Smith",
        "Johnson",
        "Brown",
        "Jones",
        "Miller",
        "Davis",
        "Garcia",
        "Rodriguez",
        "Martinez",
        "Hernandez",
        "Lopez",
        "Wilson",
    ]
    return f"{random.choice(first)} {random.choice(last)}"


def random_skill_levels(skills: Sequence[str]) -> List[Dict[str, int]]:
    out: List[Dict[str, int]] = []
    for skill in skills:
        lvl = int(round(random.gauss(6, 1.8)))
        out.append({"skill": skill, "level": max(1, min(10, lvl))})
    return out


# ---------------------------------------------------------------------------
# Section: Boardroom simulation helpers (mirrors api/start_boardroom + boardroom_step)
# ---------------------------------------------------------------------------

DIRECTIVE = (
    "This is the first meeting of a new startup. "
    "The goal is to come up with the first product or service that the company will offer. "
    "Reminder that this is the first meeting between the employees, so they don't know each other yet."
)

STAGES: List[Dict[str, object]] = [
    {"name": "INTRODUCTIONS", "minutes": 10, "goal": "everyone_spoke"},
    {"name": "BRAINSTORMING", "minutes": 15, "goal": "idea_from_each"},
    {"name": "DECIDE ON A PRODUCT", "minutes": 5, "goal": "consensus"},
    {"name": "REFINEMENT", "minutes": 10, "goal": "time_only"},
]


@dataclass
class Employee:
    name: str
    title: str
    salary: int
    personality: str
    skills: List[Dict[str, object]]


class StageClock:
    def __init__(self, emp_names: Sequence[str]):
        self.emp_names = list(emp_names)
        self.idx = 0
        self.elapsed = 0
        self.turns = 0

    @property
    def stage(self) -> str:
        return str(STAGES[self.idx]["name"])

    def tick(self) -> None:
        self.elapsed += 2
        self.turns += 1

    def should_advance(self, history: List[Dict[str, str]], outcome: Dict[str, str]) -> bool:
        goal = STAGES[self.idx]["goal"]
        if goal == "everyone_spoke":
            return len({h["speaker"] for h in history}) >= len(self.emp_names)
        if goal == "idea_from_each":
            lower = {h["speaker"] for h in history if "idea" in h["msg"].lower()}
            return len(lower) >= len(self.emp_names)
        if goal == "consensus":
            return bool(outcome.get("product"))
        return self.elapsed >= STAGES[self.idx]["minutes"]

    def advance_if_needed(self, history: List[Dict[str, str]], outcome: Dict[str, str]) -> None:
        minutes_cap = sum(s["minutes"] for s in STAGES[: self.idx + 1])
        if self.elapsed >= minutes_cap or self.should_advance(history, outcome):
            if self.idx < len(STAGES) - 1:
                self.idx += 1
                self.turns = 0


def calc_weights(
    client: AzureOpenAI,
    deployment: str,
    emps: Sequence[Employee],
    directive: str,
    recent_lines: List[Dict[str, str]],
) -> Dict[str, float]:
    sys = (
        "Re-evaluate each participants confidence weight (0-1) for the next turn.\n"
        " Start from their previous weight if given.\n"
        " Increase if their most recent comment advanced the meeting goal.\n"
        " Decrease if they sounded uncertain, repetitive, or off-topic.\n"
        "Return JSON: {name: weight}.  At least one =0.75 and one =0.25."
    )
    user = json.dumps(
        {
            "directive": directive,
            "recent_dialogue": recent_lines[-6:],
            "participants": [
                {
                    "name": e.name,
                    "title": e.title,
                    "personality": e.personality,
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
    try:
        raw = json.loads(rsp.choices[0].message.content)
    except Exception:
        raw = {}
    weights = {
        e.name: max(0.0, min(1.0, float(raw.get(e.name, random.gauss(0.5, 0.15)))))
        for e in emps
    }
    vals = list({round(v, 3) for v in weights.values()})
    if len(vals) <= 1:
        for e in emps:
            weights[e.name] = max(0.0, min(1.0, random.gauss(0.5, 0.15)))
    return weights


def pick_first_speaker(emps: Sequence[Employee], weights: Dict[str, float]) -> Employee:
    return max(emps, key=lambda e: weights.get(e.name, 0.4) + random.gauss(0, 0.05))


def choose_next_speaker(
    emps: Sequence[Employee],
    history: List[Dict[str, str]],
    weights: Dict[str, float],
) -> Employee:
    spoken = defaultdict(int)
    for h in history:
        spoken[h["speaker"]] += 1
    last = history[-1]["speaker"] if history else None
    candidates = [e for e in emps if e.name != last]
    return max(
        candidates,
        key=lambda e: (weights.get(e.name, 0.4) / (1 + spoken.get(e.name, 0))) + random.gauss(0, 0.05),
    )


def gen_agent_line(
    client: AzureOpenAI,
    deployment: str,
    agent: Employee,
    history: List[Dict[str, str]],
    directive: str,
    company: str,
    company_description: str,
    finance: Dict[str, float],
    counter: int,
    stage: str,
    emp_names: Sequence[str],
) -> str:
    sys = (
        f"You are {agent.name}, a {agent.title} at a new startup. "
        f"Company: {company}. Company description: {company_description}. "
        f"Financial constraint: The company has a bank loan of ${finance.get('amount', 0):.0f}. "
        f"The first payment due is ${finance.get('first_payment', 0):.0f} in {int(finance.get('grace_period_days', 0))} days. "
        f"Personality: {agent.personality}. Meeting goal: {directive} "
        f"Respond naturally as if you are in a real meeting. Avoid addressing colleagues by name. "
        f"Allow natural speech (pauses, doubts) but keep it collaborative. "
        f"So far, {counter * 2} minutes have passed; the meeting stage is {stage}. "
        "Respond with a single conversational line."
    )
    msgs = [{"role": "system", "content": sys}]
    for h in history[-6:]:
        msgs.append({"role": "assistant", "content": f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role": "user", "content": f"{agent.name}:"})
    rsp = client.chat.completions.create(model=deployment, messages=msgs)
    content = (rsp.choices[0].message.content or "").strip()
    lowered = content.lower()
    for name in emp_names:
        first = name.split()[0].lower()
        if lowered.startswith(name.lower()):
            content = content[len(name) :].lstrip(":,.- ").strip()
            break
        if lowered.startswith(first):
            content = content[len(first) :].lstrip(":,.- ").strip()
            break
    return content.strip()


def gen_outcome(
    client: AzureOpenAI,
    deployment: str,
    history: List[Dict[str, str]],
    emp_names: Sequence[str],
) -> Dict[str, str]:
    sys = (
        "You are an impartial meeting observer. "
        "If the conversation shows a clear consensus on a single, specific product or service idea, "
        "return JSON {'product': str, 'description': str}. "
        "At least two thirds of the participants must express support (phrases like 'sounds good', 'let's build', etc.). "
        "Otherwise return {'product': '', 'description': ''}."
    )
    transcript = "\n".join(f"{h['speaker']}: {h['msg']}" for h in history)
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": sys},
            {"role": "user", "content": transcript},
        ],
    )
    try:
        data = json.loads(rsp.choices[0].message.content)
        return {
            "product": str(data.get("product", "")),
            "description": str(data.get("description", "")),
        }
    except Exception:
        return {"product": "", "description": ""}


# ---------------------------------------------------------------------------
# Section: Work item planning helpers (mirrors api/workitems & api/estimate)
# ---------------------------------------------------------------------------


def level_avg(emp: Employee) -> float:
    lvls = [max(1, min(10, int(s.get("level", 5)))) for s in emp.skills]
    if not lvls:
        return 5.0
    return sum(lvls) / len(lvls)


def estimate_hours(complexity: int, emp_level: float) -> int:
    base = 6 + 8 * max(1, min(5, int(complexity)))
    mult = 1.0 - (emp_level - 5) * 0.05
    mult = max(0.6, min(1.4, mult))
    return int(round(base * mult))


def effort_multiplier(
    client: AzureOpenAI,
    deployment: str,
    task: Dict[str, object],
    emp: Employee,
) -> Tuple[float, int]:
    system = (
        "Estimate effort multiplier for the assignee. "
        "Return JSON {\"multiplier\": number between 0.6 and 1.4, \"reason\": string}."
    )
    payload = json.dumps(
        {
            "task": {
                "title": task.get("title", ""),
                "description": task.get("description", ""),
                "category": task.get("category", ""),
                "complexity": max(1, min(5, int(task.get("complexity", 3)))),
            },
            "assignee": {
                "title": emp.title,
                "skills": emp.skills[:8],
            },
        }
    )
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": payload},
        ],
        timeout=20,
    )
    try:
        data = json.loads(rsp.choices[0].message.content)
        mult = float(data.get("multiplier", 1.0))
        mult = max(0.6, min(1.4, mult))
    except Exception:
        mult = 1.0
    base = 6 + 8 * max(1, min(5, int(task.get("complexity", 3))))
    est = int(round(max(1, base * mult)))
    return mult, est


def llm_plan(
    client: AzureOpenAI,
    deployment: str,
    company: Dict[str, object],
    product: Dict[str, str],
    employees: Sequence[Employee],
    boardroom_history: Sequence[Dict[str, str]],
) -> List[Dict[str, object]]:
    sys = (
        "Create a comprehensive set of work items to deliver the proposed MVP end-to-end. "
        "Return strict JSON {\"workitems\": [...]} where each item has title, description, assignee_name, category, complexity. "
        "complexity is 1-5. Assign tasks to employees aligned with their titles/skills. "
        "Ground the plan in the boardroom_history transcript. Include early revenue work if funding is a loan."
    )
    transcript = "\n".join(f"{h['speaker']}: {h['msg']}" for h in boardroom_history)
    payload = json.dumps(
        {
            "company_name": company.get("name"),
            "company_description": company.get("description"),
            "funding": {
                "approved": True,
                "amount": company.get("loan_amount", 0),
                "grace_period_days": company.get("first_payment_days", 0),
                "first_payment": company.get("first_payment_amount", 0),
            },
            "product_name": product.get("name"),
            "product_description": product.get("description"),
            "employees": [
                {
                    "name": e.name,
                    "title": e.title,
                    "skills": e.skills,
                }
                for e in employees
            ],
            "boardroom_history": list(boardroom_history),
            "boardroom_transcript": transcript,
        }
    )
    rsp = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": sys},
            {"role": "user", "content": payload},
        ],
    )
    try:
        data = json.loads(rsp.choices[0].message.content)
        items = data.get("workitems") or []
        if isinstance(items, list):
            return [i for i in items if isinstance(i, dict)]
    except Exception:
        pass
    return []


# ---------------------------------------------------------------------------
# Section: Scheduling helpers
# ---------------------------------------------------------------------------

WORK_START_HOUR = 10
WORK_END_HOUR = 20
WORK_HOURS_PER_DAY = WORK_END_HOUR - WORK_START_HOUR


def align_to_work(hour: float) -> float:
    day = math.floor(hour / 24)
    hour_in_day = hour - day * 24
    if hour_in_day < WORK_START_HOUR:
        return day * 24 + WORK_START_HOUR
    if hour_in_day >= WORK_END_HOUR:
        return (day + 1) * 24 + WORK_START_HOUR
    return hour


def add_work_hours(start_hour: float, hours: float) -> float:
    current = align_to_work(start_hour)
    remaining = hours
    while remaining > 1e-6:
        day = math.floor(current / 24)
        day_end = day * 24 + WORK_END_HOUR
        available = day_end - current
        if available >= remaining:
            current += remaining
            remaining = 0.0
        else:
            remaining -= available
            current = (day + 1) * 24 + WORK_START_HOUR
    return current


def compute_schedule(work_items: Sequence[Dict[str, object]]) -> Tuple[float, Dict[str, float]]:
    finish_times: Dict[str, float] = {}
    employee_free: Dict[str, float] = defaultdict(float)

    for item in work_items:
        wid = str(item.get("id"))
        emp = str(item.get("assignee_name"))
        blockers = item.get("blockers") or []
        blocker_finish = max((finish_times[b] for b in blockers if b in finish_times), default=0.0)
        start = max(blocker_finish, employee_free[emp])
        start = align_to_work(start)
        hours = float(item.get("best_hours", item.get("estimated_hours", 0)))
        finish = add_work_hours(start, hours)
        finish_times[wid] = finish
        employee_free[emp] = finish
    total = max(finish_times.values(), default=0.0)
    return total, finish_times

# ---------------------------------------------------------------------------
# Section: Core simulation routines
# ---------------------------------------------------------------------------


def ensure_approved(
    session: requests.Session,
    url: str,
    description: str,
    timeout: float,
    attempts: int,
    backoff: float,
) -> Dict[str, object]:
    for _ in range(8):
        result = call_funding(session, url, description, timeout, attempts, backoff)
        if result.get("approved"):
            return {
                "amount": float(result.get("amount", 0)),
                "first_payment": float(result.get("first_payment", 0)),
                "grace_period_days": int(result.get("grace_period_days", 0)),
            }
    raise RuntimeError("Bank did not approve loan after retries")


def generate_company(
    client: AzureOpenAI,
    deployment: str,
    embed_model: str,
    used_names: List[str],
    used_profiles: set[Tuple[str, ...]],
    prev_embeds: List[List[float]],
    avoid_terms: Sequence[str],
    max_tries: int,
) -> Tuple[Dict[str, str], Dict[str, object]]:
    profile = sample_profile(used_profiles, len(used_names))
    anchors = INDUSTRY_ANCHORS.get(profile.get("industry"), [])
    scenario = {"name": "", "description": ""}
    for attempt in range(max_tries):
        scenario = gen_scenario(client, deployment, used_names, profile, anchors, avoid_terms)
        name, desc = scenario.get("name", ""), scenario.get("description", "")
        if not name or len(desc) < 20:
            continue
        if anchors and not satisfies_anchors(desc, anchors):
            continue
        if name_too_similar(name, used_names):
            continue
        try:
            emb_vec = embed(client, embed_model, desc)
            sim = max((cosine_sim(emb_vec, e) for e in prev_embeds), default=0.0)
            if sim > 0.86:
                continue
            prev_embeds.append(emb_vec)
        except Exception:
            pass
        used_names.append(name)
        return scenario, profile
    fallback = fallback_scenario(len(used_names) + 1)
    used_names.append(fallback["name"])
    return fallback, profile


def build_resumes(
    client: AzureOpenAI,
    deployment: str,
    roles: Sequence[str],
    skills_by_role: Dict[str, List[str]],
    candidates_per_role: int,
) -> Dict[str, List[Employee]]:
    pools: Dict[str, List[Employee]] = {}
    for role in roles:
        skills = skills_by_role.get(role, [])
        pool: List[Employee] = []
        for _ in range(max(1, candidates_per_role)):
            name = random_name()
            skill_levels = random_skill_levels(skills)
            salary = gen_salary(client, deployment, role, skill_levels)
            personality = gen_personality(client, deployment, name)
            pool.append(
                Employee(
                    name=name,
                    title=role,
                    salary=salary,
                    personality=personality,
                    skills=skill_levels,
                )
            )
        pools[role] = pool
    return pools


def hire_employees(
    roles_to_fill: Sequence[str],
    pools: Dict[str, List[Employee]],
) -> List[Employee]:
    hired: List[Employee] = []
    for role in roles_to_fill:
        pool = pools.get(role) or []
        if not pool:
            pool = [emp for emps in pools.values() for emp in emps]
        if not pool:
            raise RuntimeError("No candidates available to hire")
        hired.append(random.choice(pool))
    return hired


def simulate_boardroom(
    client: AzureOpenAI,
    deployment: str,
    company_name: str,
    company_desc: str,
    finance: Dict[str, object],
    employees: Sequence[Employee],
    max_turns: int = 24,
) -> Tuple[Dict[str, str], List[Dict[str, str]]]:
    if len(employees) < 2:
        raise ValueError("Need at least two employees for boardroom simulation")

    history: List[Dict[str, str]] = []
    emp_names = [e.name for e in employees]
    clock = StageClock(emp_names)

    weights = calc_weights(client, deployment, employees, DIRECTIVE, history)
    speaker = pick_first_speaker(employees, weights)
    line = gen_agent_line(
        client,
        deployment,
        speaker,
        history,
        DIRECTIVE,
        company_name,
        company_desc,
        finance,
        counter=0,
        stage=clock.stage,
        emp_names=emp_names,
    )
    history.append({"speaker": speaker.name, "msg": line, "stage": clock.stage})
    clock.tick()

    outcome = gen_outcome(client, deployment, history, emp_names)
    for turn in range(1, max_turns):
        if outcome.get("product") and outcome.get("description"):
            break
        weights = calc_weights(client, deployment, employees, DIRECTIVE, history)
        speaker = choose_next_speaker(employees, history, weights)
        line = gen_agent_line(
            client,
            deployment,
            speaker,
            history,
            DIRECTIVE,
            company_name,
            company_desc,
            finance,
            counter=turn,
            stage=clock.stage,
            emp_names=emp_names,
        )
        history.append({"speaker": speaker.name, "msg": line, "stage": clock.stage})
        clock.tick()
        outcome = gen_outcome(client, deployment, history, emp_names)
        clock.advance_if_needed(history, outcome)

    if not (outcome.get("product") and outcome.get("description")):
        fallback_sys = (
            "Summarize the most promising concrete product idea discussed. "
            "If none, infer a realistic MVP aligned with the conversation. Return JSON {product, description}."
        )
        transcript = "\n".join(f"{h['speaker']}: {h['msg']}" for h in history)
        rsp = client.chat.completions.create(
            model=deployment,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": fallback_sys},
                {"role": "user", "content": transcript},
            ],
        )
        try:
            data = json.loads(rsp.choices[0].message.content)
            product = str(data.get("product", "")).strip() or "Inferred MVP"
            desc = str(data.get("description", "")).strip() or "Initial product summary synthesised from discussion."
            outcome = {"product": product, "description": desc}
        except Exception:
            outcome = {
                "product": "Seed MVP",
                "description": "Founding team aligns on launching a limited-scope pilot to validate demand.",
            }
    return {"name": outcome["product"], "description": outcome["description"]}, history


def plan_work(
    client: AzureOpenAI,
    deployment: str,
    company_info: Dict[str, object],
    product: Dict[str, str],
    employees: Sequence[Employee],
    boardroom_history: Sequence[Dict[str, str]],
) -> List[Dict[str, object]]:
    planned = llm_plan(client, deployment, company_info, product, employees, boardroom_history)
    if not planned:
        raise RuntimeError("LLM failed to propose work items")

    normalized: List[Dict[str, object]] = []
    for idx, item in enumerate(planned, start=1):
        title = str(item.get("title", "")).strip() or f"Task {idx}"
        desc = str(item.get("description", "")).strip()
        category = str(item.get("category", "")).strip() or "General"
        assignee_name = str(item.get("assignee_name", "")).strip()
        complexity = max(1, min(5, int(item.get("complexity", 3))))
        normalized.append(
            {
                "id": f"w{idx}",
                "title": title,
                "description": desc,
                "category": category,
                "assignee_name": assignee_name,
                "complexity": complexity,
            }
        )

    def rank(cat: str) -> int:
        c = cat.lower()
        if any(k in c for k in ["foundation", "infra", "setup", "architecture"]):
            return 1
        if any(k in c for k in ["product", "design", "build", "engineering"]):
            return 2
        if any(k in c for k in ["qa", "testing", "analytics"]):
            return 3
        if any(k in c for k in ["marketing", "growth", "sales"]):
            return 4
        if any(k in c for k in ["launch", "release", "support"]):
            return 5
        return 2

    blockers_by_idx: Dict[int, List[str]] = {}
    for j, item in enumerate(normalized):
        rj = rank(item["category"])
        blockers: List[str] = []
        for i in range(j):
            prev = normalized[i]
            if rank(prev["category"]) < rj:
                blockers.append(prev["id"])
            if len(blockers) >= 3:
                break
        blockers_by_idx[j] = blockers

    emp_by_name = {e.name: e for e in employees}
    enriched: List[Dict[str, object]] = []
    for idx, item in enumerate(normalized):
        emp = emp_by_name.get(item["assignee_name"])
        if not emp:
            emp = random.choice(employees)
            item["assignee_name"] = emp.name
        base_hours = estimate_hours(item["complexity"], level_avg(emp))
        mult, adjusted_hours = effort_multiplier(client, deployment, item, emp)
        best_hours = min(base_hours, adjusted_hours)
        rate = round(100.0 / max(1, best_hours), 4)
        enriched.append(
            {
                **item,
                "assignee_title": emp.title,
                "estimated_hours": base_hours,
                "adjusted_hours": adjusted_hours,
                "best_hours": best_hours,
                "rate_per_hour": rate,
                "blockers": blockers_by_idx[idx],
            }
        )
    return enriched
# ---------------------------------------------------------------------------
# Section: Orchestration
# ---------------------------------------------------------------------------


def simulate_company_lifecycle(args: argparse.Namespace) -> Dict[str, object]:
    random.seed(args.seed)
    client, deployment, embed_model = make_client()
    session = create_session(args.http_retries, args.http_backoff)

    used_names: List[str] = []
    used_profiles: set[Tuple[str, ...]] = set()
    prev_embeds: List[List[float]] = []

    avoid_terms = [t.strip() for t in args.avoid_terms.split(",") if t.strip()]

    results: List[Dict[str, object]] = []
    stages = [
        "idea",
        "funding",
        "roles",
        "resumes",
        "hiring",
        "boardroom",
        "workitems",
        "schedule",
    ]

    with tqdm(total=args.count * len(stages), desc="Simulation", unit="step") as bar:
        for idx in range(args.count):
            while True:
                bar.set_postfix(company=idx + 1, stage="idea")
                scenario, profile = generate_company(
                    client,
                    deployment,
                    embed_model,
                    used_names,
                    used_profiles,
                    prev_embeds,
                    avoid_terms,
                    args.max_idea_tries,
                )
                try:
                    bar.set_postfix(company=idx + 1, stage="funding")
                    funding = ensure_approved(
                        session,
                        args.bank_url,
                        scenario["description"],
                        args.http_timeout,
                        args.http_attempts,
                        args.http_backoff,
                    )
                except RuntimeError:
                    bar.set_postfix(company=idx + 1, stage="retry_funding")
                    continue
                bar.set_postfix(company=idx + 1, stage="idea")
                bar.update(1)
                bar.set_postfix(company=idx + 1, stage="funding")
                bar.update(1)
                break

            bar.set_postfix(company=idx + 1, stage="roles")
            roles = gen_jobs(client, deployment, scenario["description"])
            if not roles:
                roles = ["Founding Engineer", "Product Manager", "Growth Lead", "Operations Manager"]
            unique_roles = list(dict.fromkeys(roles))
            skills_by_role = {role: gen_skills(client, deployment, role) for role in unique_roles}
            bar.update(1)

            bar.set_postfix(company=idx + 1, stage="resumes")
            pools = build_resumes(
                client,
                deployment,
                unique_roles,
                skills_by_role,
                candidates_per_role=args.candidates_per_role,
            )
            bar.update(1)

            bar.set_postfix(company=idx + 1, stage="hiring")
            fill_count = random.randint(3, 5)
            roles_to_fill = [random.choice(unique_roles) for _ in range(fill_count)]
            hires = hire_employees(roles_to_fill, pools)
            bar.update(1)

            bar.set_postfix(company=idx + 1, stage="boardroom")
            finance = {
                "amount": funding["amount"],
                "first_payment": funding["first_payment"],
                "grace_period_days": funding["grace_period_days"],
            }
            product, boardroom_history = simulate_boardroom(
                client,
                deployment,
                scenario["name"],
                scenario["description"],
                finance,
                hires,
            )
            bar.update(1)

            bar.set_postfix(company=idx + 1, stage="workitems")
            company_info = {
                "name": scenario["name"],
                "description": scenario["description"],
                "loan_amount": funding["amount"],
                "first_payment_amount": funding["first_payment"],
                "first_payment_days": funding["grace_period_days"],
            }
            work_items = plan_work(
                client,
                deployment,
                company_info,
                product,
                hires,
                boardroom_history,
            )
            bar.update(1)

            bar.set_postfix(company=idx + 1, stage="schedule")
            total_hours, finish_map = compute_schedule(work_items)
            bar.update(1)

            results.append(
                {
                    "company": {
                        "name": scenario["name"],
                        "description": scenario["description"],
                        "loan_amount": funding["amount"],
                        "first_payment_amount": funding["first_payment"],
                        "first_payment_days": funding["grace_period_days"],
                        "product_name": product["name"],
                        "product_description": product["description"],
                        "time_to_complete_hours": round(total_hours, 2),
                    },
                    "employees": [
                        {
                            "name": emp.name,
                            "role": emp.title,
                            "salary": emp.salary,
                            "personality": emp.personality,
                            "skillsets": [
                                {"name": s["skill"], "level": s["level"]}
                                for s in emp.skills
                            ],
                        }
                        for emp in hires
                    ],
                    "work_items": [
                        {
                            "id": item["id"],
                            "title": item["title"],
                            "description": item["description"],
                            "assignee_name": item["assignee_name"],
                            "assignee_title": item["assignee_title"],
                            "blockers": item["blockers"],
                            "blocker_count": len(item["blockers"]),
                            "complexity": item["complexity"],
                            "estimated_hours": item["estimated_hours"],
                            "adjusted_hours": item["adjusted_hours"],
                            "best_hours": item["best_hours"],
                            "rate_per_hour": item["rate_per_hour"],
                            "finish_hour": round(finish_map.get(item["id"], 0.0), 2),
                        }
                        for item in work_items
                    ],
                }
            )

    return {"generated_at": dt.datetime.utcnow().isoformat() + "Z", "companies": results}


# ---------------------------------------------------------------------------
# Section: CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    default_out = (Path(__file__).resolve().parent / "archive" / "output.json").as_posix()
    p = argparse.ArgumentParser(description="Run an end-to-end company simulation")
    p.add_argument("--count", type=int, default=5, help="Number of companies to simulate")
    p.add_argument("--outfile", type=str, default=default_out, help="Path to write simulation JSON")
    p.add_argument("--bank-url", type=str, default="https://fa-strtupifyio.azurewebsites.net/api/funding", help="Funding Azure Function endpoint")
    p.add_argument("--avoid-terms", type=str, default="eco,pack,packaging,sustainable,biodegradable,compostable,eco-friendly")
    p.add_argument("--max-idea-tries", type=int, default=5, help="Attempts per idea before fallback")
    p.add_argument("--http-retries", type=int, default=4)
    p.add_argument("--http-timeout", type=float, default=60.0)
    p.add_argument("--http-attempts", type=int, default=6)
    p.add_argument("--http-backoff", type=float, default=0.75)
    p.add_argument("--candidates-per-role", type=int, default=3, help="Number of resumes to generate per role")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    payload = simulate_company_lifecycle(args)
    out_path = Path(args.outfile)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    os.replace(tmp_path, out_path)
    print(f"Wrote simulation output to {out_path}")


if __name__ == "__main__":
    main()
