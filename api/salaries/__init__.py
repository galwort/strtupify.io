import azure.functions as func
from json import dumps, loads
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import OpenAI

vault_url = "https://kv-galwort.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)
client = OpenAI(api_key=secret_client.get_secret("OAIKey").value)


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
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=messages,
    )

    salary = loads(response.choices[0].message.content)["salary"]
    return salary


def main(req: func.HttpRequest) -> func.HttpResponse:
    req_body = req.get_json()
    job_title = req_body["job_title"]
    skills = req_body["skills"]

    salary = gen_salary(job_title, skills)

    return func.HttpResponse(dumps({"salary": salary}), mimetype="application/json")
