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
    product_description = accepted_product.get("description") if accepted_product else ""

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
            skills = [d.to_dict() for d in skills_info]
            for skill in skills:
                skill.pop("updated", None)
            employee["skills"] = skills
            employee_json.append(employee)

    return {
        "company_name": company_name,
        "company_description": company_description,
        "product_name": product_name,
        "product_description": product_description,
        "employees": employee_json,
    }


def analyze_reply(context_json, reply_text, thread_json):
    system_message = (
        "You will analyze a founder's reply to a kickoff plan and produce a JSON response. "
        "Decide one of: approved, rejected, suggestions, unknown. "
        "Rules: approved means clear approval, rejected means clear rejection with no changes, "
        "suggestions means the reply proposes changes (to product or roles or plan), unknown otherwise. "
        "Generate a concise assistant reply matching the case: "
        "approved -> casual short acknowledgement, rejected -> ask what changes are needed, "
        "suggestions -> propose a new plan incorporating the suggestions, unknown -> ask for an approval decision. ""
        "Also include an optional 'changes' object when status is 'suggestions' with this shape: "
        "{ 'product': { 'name': string, 'description': string }, 'roles': [ { 'title': string, 'openings': number, 'skills': string[] } ] }. "
        "If a field is not being changed, omit it. "
        "Respond as a JSON object with keys: status, assistant_reply, changes. "
        "Status is one of: approved, rejected, suggestions, unknown. "
        "assistant_reply is plain text suitable as an email body."
    )
    user_message = (
        "Context JSON with current plan and team: \n\n" + dumps(context_json) + "\n\n" +
        "Thread history as JSON array oldest-to-newest: \n\n" + dumps(thread_json) + "\n\n" +
        "Founder reply: \n\n" + reply_text
    )
    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message},
        ],
    )
    data = loads(response.choices[0].message.content)
    status = str(data.get("status", "unknown")).lower()
    assistant_reply = data.get("assistant_reply", "")
    changes = data.get("changes") or {}
    if status not in ["approved", "rejected", "suggestions", "unknown"]:
        status = "unknown"
    if not assistant_reply:
        assistant_reply = "Sorry, I didn't understand. Do you approve of this plan?"
    return status, assistant_reply, changes


def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    company = body.get("name")
    thread_id = body.get("threadId")
    reply_text = body.get("reply", "")
    thread_history = body.get("thread") or []
    if not company or not thread_id or not reply_text:
        return func.HttpResponse(dumps({"error": "missing fields"}), status_code=400)

    kickoff_ref = db.collection("companies").document(company).collection("inbox").document(thread_id)
    kickoff_doc = kickoff_ref.get()
    if not kickoff_doc.exists:
        return func.HttpResponse(dumps({"error": "thread not found"}), status_code=404)
    subject = kickoff_doc.get("subject") or "Kickoff"
    from_addr = kickoff_doc.get("from") or "noreply@strtupify.io"

    ctx = pull_company_info(company)
    status, assistant_reply, changes = analyze_reply(ctx, reply_text, thread_history)

    if status == "suggestions":
        try:
            roles_changes = (changes or {}).get("roles") or []
            product_changes = (changes or {}).get("product") or {}
            company_ref = db.collection("companies").document(company)
            if product_changes:
                prod_ref = company_ref.collection("products").where("accepted", "==", True).get()
                for d in prod_ref:
                    if "name" in product_changes:
                        d.reference.update({"product": product_changes.get("name")})
                    if "description" in product_changes:
                        d.reference.update({"description": product_changes.get("description")})
            if roles_changes:
                roles_ref = company_ref.collection("roles").get()
                by_title = {r.get("title"): r for r in roles_ref}
                for rc in roles_changes:
                    title = rc.get("title")
                    if not title:
                        continue
                    openings = rc.get("openings")
                    skills = rc.get("skills")
                    existing = by_title.get(title)
                    if existing:
                        updates = {}
                        if openings is not None:
                            updates["openings"] = openings
                        if skills is not None:
                            updates["skills"] = skills
                        if updates:
                            existing.reference.update(updates)
                    else:
                        payload = {"title": title}
                        if openings is not None:
                            payload["openings"] = openings
                        if skills is not None:
                            payload["skills"] = skills
                        company_ref.collection("roles").add(payload)
        except Exception:
            pass

    out = {"from": from_addr, "subject": f"Re: {subject}", "body": assistant_reply, "status": status}
    return func.HttpResponse(dumps(out), mimetype="application/json")