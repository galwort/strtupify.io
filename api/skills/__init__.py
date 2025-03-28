import azure.functions as func
from json import dumps, loads
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import AzureOpenAI

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)
endpoint = secret_client.get_secret("AIEndpoint").value
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeploymentMini").value
client = AzureOpenAI(
    api_version="2023-07-01-preview", azure_endpoint=endpoint, api_key=api_key
)


def gen_skills(job_title):
    system_message = (
        "You are a job skills generator. "
        + "When given the title of a job, "
        + "your task is to reply with a list of skills "
        + "that would be needed for that job. "
        + "You should generate no more than 5 skills. "
        + "The skills should be concise and no more than a couple words. "
        + "The skills should be in proper case. "
        + "Reply in JSON format with the word 'skills' as the key, "
        + "and the skills as a list of strings as the value."
    )

    messages = [{"role": "system", "content": system_message}]
    user_message = {"role": "user", "content": job_title}
    messages.append(user_message)

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=messages,
    )

    skills = loads(response.choices[0].message.content)["skills"]

    return skills


def main(req: func.HttpRequest) -> func.HttpResponse:
    req_body = req.get_json()
    job_title = req_body["job_title"]

    skills = gen_skills(job_title)

    return func.HttpResponse(dumps({"skills": skills}), mimetype="application/json")
