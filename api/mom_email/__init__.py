import azure.functions as func
import firebase_admin

from json import dumps, loads
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
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

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()


def pull_company_info(company):
    company_ref = db.collection("companies").document(company)
    company_info = company_ref.get()
    company_name = company_info.get("company_name")
    company_description = company_info.get("description")

    product_ref = company_ref.collection("products")
    product_info = product_ref.get()
    accepted_product = None
    for product in product_info:
        if product.get("accepted") == True:
            accepted_product = product
            break
    product_name = accepted_product.get("product") if accepted_product else ""
    product_description = (
        accepted_product.get("description") if accepted_product else ""
    )

    return {
        "company_name": company_name,
        "company_description": company_description,
        "product_name": product_name,
        "product_description": product_description,
    }


def gen_mom_email(
    company_name: str,
    company_description: str,
    product_name: str,
    product_description: str,
    snack_name: str,
):
    from_address = "mom@altavista.net"

    system_message = (
        "You are the user's mother writing a brief email to them on day 2 of their new startup. "
        "Your tone is superficially kind but slightly condescending and 'worried'. "
        "Avoid formal salutations like 'Dear [Name]'; write casually. "
        "Keep it short: 3-6 sentences. "
        "Mention the startup idea briefly using the provided context. "
        "Also include a gentle jab about stress eating, referencing the provided snack."
    )

    context = (
        f"Company: {company_name}. "
        f"Company description: {company_description}. "
        f"Product: {product_name}. Description: {product_description}. "
        f"Snack to reference: {snack_name}."
    )

    user_message = (
        "Write an email JSON object of the form: "
        "{\"email\": {\"subject\": string, \"body\": string}, \"error\": string}. "
        "Set error to an empty string on success. "
        "The subject should sound like a concerned parent (e.g., 'Just checking in')."
    )

    messages = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": context},
        {"role": "user", "content": user_message},
    ]

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=messages,
    )

    email = loads(response.choices[0].message.content)

    if "error" in email and email["error"]:
        return {"error": email["error"]}

    subject = email["email"].get("subject", "Just checking in")
    email_body = email["email"]["body"]
    email_message = {"from": from_address, "subject": subject, "body": email_body}
    return email_message


def main(req: func.HttpRequest) -> func.HttpResponse:
    req_body = req.get_json()
    company = req_body.get("name")
    snack = req_body.get("snack", "snacks")

    if not company:
        return func.HttpResponse(
            dumps({"error": "Missing company name"}), status_code=400
        )

    company_info = pull_company_info(company)

    mom_email = gen_mom_email(
        company_info.get("company_name", ""),
        company_info.get("company_description", ""),
        company_info.get("product_name", ""),
        company_info.get("product_description", ""),
        snack,
    )

    if "error" in mom_email:
        return func.HttpResponse(
            dumps({"error": mom_email["error"]}), mimetype="application/json"
        )
    else:
        return func.HttpResponse(dumps(mom_email), mimetype="application/json")

