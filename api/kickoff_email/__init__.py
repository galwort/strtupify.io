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
    for product in product_info:
        if product.get("accepted") == True:
            accepted_product = product
            break
    product_name = accepted_product.get("product")
    product_description = accepted_product.get("description")

    employee_ref = company_ref.collection("employees")
    employee_info = employee_ref.get()
    employee_json = []
    for doc in employee_info:
        if doc.get("hired") == True:
            employee = doc.to_dict()
            employee.pop("created", None)
            employee.pop("updated", None)
            employee.pop("hired", None)
            skills_ref = doc.reference.collection("skills")
            skills_info = skills_ref.get()
            skills = [doc.to_dict() for doc in skills_info]
            for skill in skills:
                skill.pop("updated", None)
            employee["skills"] = skills
            employee_json.append(employee)

    return {
        "company_name": company_name,
        "company_description": company_description,
        "product_name": product_name,
        "product_description": product_description,
        "employees": employee_json
    }

def pick_sender(job_title_json):
    system_message = (
        "Given a JSON object with the name and job title of employees, "
        "your task is to reply with a JSON object containing only the name and title "
        "of the employee who would be most likely to send the email on behalf of the company. "
        "The output should be in the format: {\"name\": \"<name>\", \"title\": \"<title>\"}."
    )

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": job_title_json}
        ],
    )

    sender_data = loads(response.choices[0].message.content)
    sender_name = sender_data["name"]
    sender_title = sender_data["title"]

    return sender_name, sender_title

def gen_kickoff_email(company_name, company_description, product_name, product_description, employee_json, sender_name, sender_title):
    from_name = sender_name.replace(" ", ".").lower()
    from_domain = company_name.replace(" ", "").lower() + ".com"
    from_address = f"{from_name}@{from_domain}"

    subject = f"Kickoff Email for {company_name} - {product_name}"

    system_message = (
        f"Your name is {sender_name}, and you are a {sender_title} at {company_name}. "
        f"Here is a brief description of what the company does: {company_description}. "
        f"Here is some JSON with information on the employees at the company: \n\n{employee_json}\n\n"
        "In an earlier meeting, you and the rest of the employees came up with the first product. "
        f"\n\n{product_name}: {product_description}.\n\n"
    )

    user_message = (
        "You need to come up with the body of a kickoff email to the company's founder. "
        "You don't know the founder's name, so just avoid using it. "
        "Do not use any kind of template like 'Dear [Name]' or 'To whom it may concern'. "
        "Your email should describe the project that was come up with, "
        "followed by assignments for what each of the employees are going to be working on, "
        "followed by a sign-off note asking for approval on plan."
        "Reply in JSON format with an overall key of 'email', and then within that object, "
        "There should me a key value pair of 'body' with the text of the email, "
        "and a key value of error, if there was any kind of issue processing the request. "
        "The value of the error key should be and empty string if there is no error."
    )

    messages = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": user_message}
    ]

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=messages,
    )

    email = loads(response.choices[0].message.content)

    if "error" in email:
        return email["error"]
    else:
        email_body = email["email"]["body"]
        email_message = {
            "from": from_address,
            "subject": subject,
            "body": email_body
        }
        return email_message

def main(req: func.HttpRequest) -> func.HttpResponse:
    req_body = req.get_json("company")
    company = req_body["name"]
    company_info = pull_company_info(company)
    company_name = company_info["company_name"]
    company_description = company_info["company_description"]
    product_name = company_info["product_name"]
    product_description = company_info["product_description"]
    employee_json = company_info["employees"]

    job_title_json = {
        employee["name"]: employee["title"]
        for employee in employee_json
    }
    job_title_json = dumps(job_title_json)
    sender_name, sender_title = pick_sender(job_title_json)

    kickoff_email = gen_kickoff_email(
        company_name,
        company_description,
        product_name,
        product_description,
        employee_json,
        sender_name,
        sender_title
    )

    if "error" in kickoff_email:
        return func.HttpResponse(dumps({"error": kickoff_email["error"]}), mimetype="application/json")
    else:
        return func.HttpResponse(dumps(kickoff_email), mimetype="application/json")