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
deployment = secret_client.get_secret("AIDeployment").value
client = AzureOpenAI(
    api_version="2023-07-01-preview", azure_endpoint=endpoint, api_key=api_key
)


def gen_order(company_description):
    system_message = (
        "You are tasked with coming up with a humorous Amazon order. "
        "When given the description of a company, "
        "your job is to come up with a humorous object that an employee of the company might order off of Amazon. "
        "You are to respond in JSON with the word order as the overall key. "
        "Within the key object, there should be three key value pairs. "
        "One named product, which should have the name of the order. "
        "One named cost, which would be a decimal value for how much one of the product would cost. "
        "One named quantity, which would be an integer value for how many of the products you ordered. "
        "The product should be short, and should actually exist. "
        "The product should not be funny because of the title, but because it is being bought. "
        "To clarify, the product should be something an average consumer has heard of before., "
        "without any adjectives or descriptive words to enhance the product. "
    )

    messages = [{"role": "system", "content": system_message}]
    user_message = {"role": "user", "content": company_description}
    messages.append(user_message)

    while True:
        response = client.chat.completions.create(
            model=deployment,
            response_format={"type": "json_object"},
            messages=messages,
            temperature=1.5,
        )

        order = loads(response.choices[0].message.content)
        product = order["order"]["product"]

        if len(product) <= 32:
            break

    return order


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        req_body = req.get_json()
        company_description = req_body["company_description"]

        response = gen_order(company_description)

        return func.HttpResponse(
            dumps(response), status_code=200, mimetype="application/json"
        )
    except Exception as e:
        return func.HttpResponse(str(e), status_code=500)
