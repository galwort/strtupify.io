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
        "You are a hiring planner for an early-stage startup. "
        + "Given a company description, return a JSON object with a 'jobs' array of no more than 8 role titles the company should hire for. "
        + "Favor a cross-functional mix spanning various departments as appropriate for the company's focus. "
        + "If the description is vague or incomplete, infer a plausible set of roles for a typical early-stage product company rather than returning an empty list. "
        + "Only return an empty list when the description clearly states no hiring is needed. "
        + "Keep titles concise and reply in strict JSON with key 'jobs' (list of strings). "
        + "If there is a hard error parsing the input, include an 'error' key and set 'jobs' to an empty list."
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
