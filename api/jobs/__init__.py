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


def gen_jobs(company_description):
    system_message = (
        "You are a job title generator. "
        + "When given a description of a company, "
        + "your job is to reply with a list of job titles "
        + "that the company should hire for. "
        + "You should generate no more than 8 job titles. "
        + "Reply in JSON format with the word 'jobs' as the key, "
        + "and the job titles as a list of strings as the value. "
        + "If there is an issue, leave the value as an empty list, "
        + "and describe the issue in the 'error' key. "
        + "If there is no issue, leave the 'error' key out."
    )

    messages = [{"role": "system", "content": system_message}]
    user_message = {"role": "user", "content": company_description}
    messages.append(user_message)

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=messages,
    )

    return response.choices[0].message.content


def main(req: func.HttpRequest) -> func.HttpResponse:
    req_body = req.get_json()
    company_description = req_body["company_description"]

    response = gen_jobs(company_description)

    if "error" in response:
        error = loads(response)["error"]
        return func.HttpResponse(dumps({"error": error}), mimetype="application/json")
    else:
        jobs = loads(response)["jobs"]
        return func.HttpResponse(dumps({"jobs": jobs}), mimetype="application/json")
