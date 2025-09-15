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


def gen_funding(company_description):
    system_message = (
        "You are a startup loan officer. "
        + "Given a company description, decide whether to approve a loan and return a strict JSON object. "
        + "Respond with keys: approved (boolean), amount (number), grace_period_days (integer), first_payment (number). "
        + "If you cannot decide, set approved to false and other numbers to 0. "
        + "No prose, JSON only."
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

    response = gen_funding(company_description)

    data = loads(response)
    if "error" in data:
        return func.HttpResponse(dumps({"error": data["error"]}), mimetype="application/json")
    else:
        approved = bool(data.get("approved", False))
        amount = float(data.get("amount", 0))
        grace_period_days = int(data.get("grace_period_days", 0))
        first_payment = float(data.get("first_payment", 0))
        return func.HttpResponse(
            dumps(
                {
                    "approved": approved,
                    "amount": amount,
                    "grace_period_days": grace_period_days,
                    "first_payment": first_payment,
                }
            ),
            mimetype="application/json",
        )

