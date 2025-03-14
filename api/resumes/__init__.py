import azure.functions as func
import firebase_admin

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, firestore
from json import dumps, loads
from openai import AzureOpenAI
from random import gauss
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
firebase_admin.initialize_app(cred)
db = firestore.client()


def pull_name():
    url = "https://randomuser.me/api/?nat=us"
    response = get(url)
    name = response.json()["results"][0]["name"]["first"]
    return name


def pull_skills():
    pass


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
    # pull skills
    # run functions
    # post to firestore
