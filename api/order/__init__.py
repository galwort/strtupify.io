import azure.functions as func
import firebase_admin
import json
from typing import Any, Dict

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, firestore, initialize_app
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, ValidationError

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

endpoint = secret_client.get_secret("AIEndpoint").value.rstrip("/")
api_key = secret_client.get_secret("AIKey").value
deployment = secret_client.get_secret("AIDeploymentMini").value
client = OpenAI(api_key=api_key, base_url=f"{endpoint}/openai/v1/")

firestore_sdk = secret_client.get_secret("FirebaseSDK").value
cred = credentials.Certificate(json.loads(firestore_sdk))
if not firebase_admin._apps:
    initialize_app(cred)
db = firestore.client()


class CadabraOrder(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    item: str = Field(..., min_length=2, max_length=120)
    quantity: int = Field(..., ge=1, le=50)
    unit_price: float = Field(..., gt=0, le=5000)
    total: float | None = Field(default=None, gt=0, le=20000)


def _prompt_for_order(description: str) -> CadabraOrder:
    system_message = (
        "You imagine a humorous but plausible Amazon purchase a naive VC might make for a startup. "
        "Stick to real, recognizable products without adjectives or add-ons. "
        "Return only JSON that matches the schema."
    )
    user_prompt = (
        "Given this description for a company, come up with a humorous item that a VC who doesn’t know any better, "
        "might purchase for said company. The purchase must be formatted as a purchase from Amazon, with a quantity and price. "
        "The title of product should just be the product and nothing else. Lean toward existing items instead of items that are tailored toward the specific company description. "
        "The total cost should be more than $3 but less than $1,000\n\n"
        f"{description}"
    )
    completion = client.beta.chat.completions.parse(
        model=deployment,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.7,
        top_p=0.9,
        max_tokens=256,
        response_format=CadabraOrder,
    )
    parsed = completion.choices[0].message.parsed
    if not isinstance(parsed, CadabraOrder):
        raise ValueError("LLM parse failure")
    return parsed


def _normalize(order: CadabraOrder) -> Dict[str, Any]:
    item = order.item.strip() or "Office chair mat"
    qty = order.quantity if order.quantity and order.quantity > 0 else 1
    qty = min(max(int(qty), 1), 50)
    unit = float(order.unit_price) if order.unit_price and order.unit_price > 0 else 19.99
    unit = round(unit, 2)
    total = float(order.total) if order.total and order.total > 0 else unit * qty
    if total < 3:
        total = 3.25
    elif total > 999.99:
        total = 999.99
    unit = round(total / qty, 2) if qty else unit
    return {
        "item": item,
        "quantity": qty,
        "unit_price": unit,
        "total": round(total, 2),
    }


def _fallback_order() -> CadabraOrder:
    return CadabraOrder(item="Conference room speaker", quantity=1, unit_price=89.99, total=89.99)


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        payload = req.get_json()
    except Exception:
        return func.HttpResponse(
            json.dumps({"error": "invalid json"}),
            mimetype="application/json",
            status_code=400,
        )

    company_id = str((payload or {}).get("name") or (payload or {}).get("company") or "").strip()
    if not company_id:
        return func.HttpResponse(
            json.dumps({"error": "missing company"}),
            mimetype="application/json",
            status_code=400,
        )

    company_doc = db.collection("companies").document(company_id).get()
    data = company_doc.to_dict() if company_doc.exists else {}
    company_desc = str(data.get("description") or "").strip()
    company_name = str(data.get("company_name") or company_id).strip()
    description = f"{company_name}: {company_desc}" if company_desc else company_name

    try:
        parsed = _prompt_for_order(description)
    except (ValidationError, Exception):
        parsed = _fallback_order()

    normalized = _normalize(parsed)
    normalized["company"] = company_id

    return func.HttpResponse(
        json.dumps(normalized),
        mimetype="application/json",
        status_code=200,
    )
