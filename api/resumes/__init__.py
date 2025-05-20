import azure.functions as func
import firebase_admin

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
from json import dumps, loads
from openai import AzureOpenAI
from random import choice, gauss
from requests import get

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeploymentMini").value
client = AzureOpenAI(
    api_version="2023-07-01-preview", azure_endpoint=endpoint, api_key=api_key
)

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()


def pull_name():
    url = "https://randomuser.me/api/?nat=us"
    try:
        r = get(url, timeout=5)
        r.raise_for_status()
        d = r.json()["results"][0]["name"]
        return f"{d['first']} {d['last']}"
    except Exception:
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
        ]
        return f"{choice(first)} {choice(last)}"


def pull_skills(company, job_title):
    ref = db.collection("companies").document(company).collection("roles")
    docs = ref.where("title", "==", job_title).limit(1).get()
    if docs:
        return docs[0].to_dict().get("skills", [])
    return []


def get_skill_levels():
    for i in range(5):
        yield max(1, min(10, round(gauss(5, 2))))


def gen_personality(name):
    system_message = (
        "You are a personality generator. When given the name of a person, "
        + "your task is to reply with a short, concise description of their personality. "
        + "The description should be no more than a couple of sentences. "
        + "Do not assume the gender of the person. "
        + "Reply in JSON format with the word 'personality' as the key, "
        + "and the description as the value."
    )

    messages = [{"role": "system", "content": system_message}]
    user_message = {"role": "user", "content": name}
    messages.append(user_message)

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=messages,
    )

    personality = loads(response.choices[0].message.content)["personality"]

    return personality


def gen_salary(job_title, skills):
    system_message = (
        "You are a salary generator. When given the title of a job, "
        + "and a list of skills with their respective levels of a candidate, "
        + "your task is to reply with the salary that would be appropriate for that candidate. "
        + "The skill levels range from 1 to 10, with 10 being the highest. "
        + "Reply in JSON format with the word 'salary' as the key and the salary as the value. "
        + "The salary should be an integer."
    )

    messages = [{"role": "system", "content": system_message}]
    user_message = {
        "role": "user",
        "content": dumps(
            {
                "job_title": job_title,
                "skills": skills,
            }
        ),
    }
    messages.append(user_message)

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=messages,
    )

    salary = loads(response.choices[0].message.content)["salary"]
    return salary


def main(req: func.HttpRequest) -> func.HttpResponse:
    req_body = req.get_json()
    company = req_body["company"]
    job_title = req_body["job_title"]

    company_doc = db.collection("companies").document(company).get()
    if not company_doc.exists:
        return func.HttpResponse(
            dumps({"error": "Company does not exist"}), status_code=400
        )

    roles_ref = db.collection("companies").document(company).collection("roles")
    docs = roles_ref.where("title", "==", job_title).limit(1).get()
    if not docs:
        return func.HttpResponse(
            dumps({"error": "Job title does not exist for this company"}),
            status_code=400,
        )

    skills = docs[0].to_dict().get("skills", [])
    name = pull_name()
    personality = gen_personality(name)
    skill_data = []
    for s in skills:
        skill_data.append({"skill": s, "level": max(1, min(10, round(gauss(5, 2))))})
    salary = gen_salary(job_title, skill_data)
    ref = db.collection("companies").document(company).collection("employees")
    docs_employee = ref.get()
    if not docs_employee:
        employee_id = 1
    else:
        employee_id = max(int(d.id) for d in docs_employee if d.id.isdigit()) + 1
    new_employee = ref.document(str(employee_id))
    new_employee.set(
        {
            "name": name,
            "title": job_title,
            "salary": salary,
            "personality": personality,
            "hired": False,
            "created": firestore.SERVER_TIMESTAMP,
            "updated": firestore.SERVER_TIMESTAMP,
        }
    )
    skill_ref = new_employee.collection("skills")
    for item in skill_data:
        skill_ref.add(
            {
                "skill": item["skill"],
                "level": item["level"],
                "updated": firestore.SERVER_TIMESTAMP,
            }
        )
    return func.HttpResponse(dumps({"employeeId": employee_id}), status_code=200)
