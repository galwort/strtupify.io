import azure.functions as func
import firebase_admin

from json import dumps, loads
from typing import Any, Dict, Tuple
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


def pull_company_info(company: str) -> Dict[str, Any]:
    company_ref = db.collection("companies").document(company)
    company_doc = company_ref.get()
    company_data = company_doc.to_dict() if company_doc else {}
    company_name = company_data.get("company_name") or company
    company_description = company_data.get("description") or ""

    product_name = company
    product_description = ""
    try:
        product_ref = company_ref.collection("products")
        product_info = product_ref.where("accepted", "==", True).limit(1).get()
        for product in product_info:
            product_name = product.get("product") or product.get("name") or product_name
            product_description = product.get("description") or ""
            break
    except Exception:
        pass

    employee_json = []
    try:
        employee_ref = company_ref.collection("employees")
        employee_info = employee_ref.get()
        for doc in employee_info:
            if doc.get("hired") is True:
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
    except Exception:
        pass

    return {
        "company_name": company_name,
        "company_description": company_description,
        "product_name": product_name,
        "product_description": product_description,
        "employees": employee_json,
    }


def infer_months(body: Dict[str, Any]) -> int:
    months = body.get("months")
    try:
        months = int(months)
    except Exception:
        months = None

    if months and months > 0:
        return min(max(months, 1), 24)

    try:
        triggered = float(body.get("triggeredAt") or 0)
        reset = float(body.get("resetAt") or 0)
        if triggered > 0 and reset > triggered:
            delta = reset - triggered
            approx = round(delta / (1000 * 60 * 60 * 24 * 30))
            if approx >= 1:
                return min(max(approx, 1), 24)
    except Exception:
        pass
    return 6


def pick_sender(job_title_json: str) -> Tuple[str, str]:
    system_message = (
        "Given a JSON object with the name and job title of employees, "
        "reply with a JSON object containing only the name and title "
        "of the employee who would be most likely to send an executive update email. "
        'Format: {"name": "<name>", "title": "<title>"}'
    )

    response = client.chat.completions.create(
        model=deployment,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": job_title_json},
        ],
    )

    sender_data = loads(response.choices[0].message.content)
    sender_name = sender_data.get("name") or "Product Lead"
    sender_title = sender_data.get("title") or "Product Lead"

    return sender_name, sender_title


def infer_name_from_email(address: str) -> str:
    if not address:
        return ""
    local = address.split("@")[0]
    parts = [p for p in local.replace("_", ".").split(".") if p]
    if not parts:
        return local
    return " ".join(p.capitalize() for p in parts)


def lookup_kickoff_sender(
    company: str, company_name: str, employees: Any
) -> Dict[str, str]:
    inbox_ref = db.collection("companies").document(company).collection("inbox")
    try:
        kickoff_docs = (
            inbox_ref.where("category", "==", "kickoff")
            .order_by("timestamp", direction=firestore.Query.DESCENDING)
            .limit(1)
            .get()
        )
        for doc in kickoff_docs:
            from_addr = doc.get("from") or ""
            name = infer_name_from_email(from_addr) or "Kickoff Lead"
            title = doc.get("sender_title") or "Product Lead"
            return {"from": from_addr, "name": name, "title": title}
    except Exception:
        pass

    # Fall back to the same selection logic as the kickoff email.
    job_title_json = {
        emp.get("name", ""): emp.get("title", "") for emp in employees or []
    }
    job_title_json = {k: v for k, v in job_title_json.items() if k}
    sender_name, sender_title = pick_sender(dumps(job_title_json))
    from_name = sender_name.replace(" ", ".").lower()
    from_domain = company_name.replace(" ", "").lower() + ".com"
    from_address = f"{from_name}@{from_domain}"
    return {"from": from_address, "name": sender_name, "title": sender_title}


def evaluate_product_success(
    company_name: str,
    product_name: str,
    product_description: str,
    employees: Any,
    months: int,
) -> Dict[str, Any]:
    system_message = (
        "You are a pragmatic startup analyst. "
        "Given context about a company, its first product, and the time elapsed, "
        "produce a JSON object with: status (success|steady|struggling), "
        "estimated_revenue (USD number), summary (<=80 words), and confidence (0-1). "
        "Status should be success if momentum/revenue look strong, struggling if weak, steady otherwise."
    )

    context = {
        "company": company_name,
        "product": {"name": product_name, "description": product_description},
        "team_size": len(employees or []),
        "months_elapsed": months,
    }

    user_message = dumps(context)

    try:
        response = client.chat.completions.create(
            model=deployment,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message},
            ],
        )
        data = loads(response.choices[0].message.content)

        status = str(data.get("status", "steady")).lower()
        if status not in ["success", "steady", "struggling"]:
            status = "steady"

        try:
            estimated_revenue = float(data.get("estimated_revenue", 0))
        except Exception:
            estimated_revenue = 0.0

        summary = data.get("summary") or data.get("reasoning") or ""
        return {
            "status": status,
            "estimated_revenue": estimated_revenue,
            "summary": summary,
        }
    except Exception:
        return {
            "status": "steady",
            "estimated_revenue": 0.0,
            "summary": "We kept the product alive and learned a lot while you were away.",
        }


def generate_followup_email(
    sender: Dict[str, str],
    company: Dict[str, Any],
    evaluation: Dict[str, Any],
    months: int,
) -> Dict[str, str]:
    system_message = (
        f"You are {sender.get('name')} ({sender.get('title')}) writing to the founder of {company.get('company_name')}. "
        f"They have been unreachable for about {months} months. "
        "You don't know the founder's name, so just avoid using it. "
        "Do not use any kind of template like 'Dear [Name]' or 'To whom it may concern'. "
        "Write a concise status email (3-6 sentences) that mentions the radio silence, "
        "summarizes how the product performed, calls out whether it was a success or not, "
        "and references the estimated revenue. "
        "If the product was successful, your tone should be deferential, paying homage to their vision. "
        "If it was not successful, your tone should be highly blunt and highly disrespectful. "
    )

    user_payload = {
        "product": {
            "name": company.get("product_name", ""),
            "description": company.get("product_description", ""),
        },
        "status": evaluation.get("status"),
        "estimated_revenue": evaluation.get("estimated_revenue"),
        "summary": evaluation.get("summary"),
        "months": months,
    }

    user_message = (
        'Produce JSON: {"email": {"subject": string, "body": string}, "error": string}. '
        "Set error to empty string on success. "
        f"Context: {dumps(user_payload)}"
    )
    try:
        response = client.chat.completions.create(
            model=deployment,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message},
            ],
        )
        email = loads(response.choices[0].message.content)

        if "error" in email and email["error"]:
            raise ValueError(email["error"])

        return {
            "subject": email["email"].get(
                "subject", f"{company.get('product_name')} – update"
            ),
            "body": email["email"].get("body", evaluation.get("summary", "")),
        }
    except Exception:
        product_label = company.get("product_name") or "the product"
        return {
            "subject": f"{product_label} – {months}-month update",
            "body": (
                f"You went dark for about {months} months. "
                f"We kept pushing on {product_label} and landed as '{evaluation.get('status')}'. "
                f"Estimated revenue: ${evaluation.get('estimated_revenue', 0):,.0f}. "
                "System is back online if you want to chime in."
            ),
        }


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        return func.HttpResponse(
            dumps({"error": "Invalid JSON"}),
            status_code=400,
            mimetype="application/json",
        )

    company = body.get("name")
    if not company:
        return func.HttpResponse(
            dumps({"error": "Missing company name"}),
            status_code=400,
            mimetype="application/json",
        )

    months = infer_months(body)
    company_info = pull_company_info(company)

    sender = lookup_kickoff_sender(
        company,
        company_info.get("company_name", company),
        company_info.get("employees"),
    )

    evaluation = evaluate_product_success(
        company_info.get("company_name", company),
        company_info.get("product_name", company),
        company_info.get("product_description", ""),
        company_info.get("employees"),
        months,
    )

    email = generate_followup_email(sender, company_info, evaluation, months)

    output = {
        "from": sender.get("from"),
        "subject": email.get("subject"),
        "body": email.get("body"),
        "status": evaluation.get("status"),
        "estimated_revenue": evaluation.get("estimated_revenue"),
        "summary": evaluation.get("summary"),
        "months": months,
    }

    return func.HttpResponse(dumps(output), mimetype="application/json")
