import azure.functions as func
import firebase_admin
import json
import random
from typing import Any, Dict, List

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


def _prompt_for_order(description: str, prev_items: List[str]) -> CadabraOrder:
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
    if prev_items:
        prior = ", ".join(prev_items[:15])
        user_prompt += (
            "\n\nAvoid repeating any of these previously purchased items. "
            f"All suggestions must be different from: {prior}"
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


def _fallback_order(prev_items: List[str]) -> CadabraOrder:
    candidates = [
        ("Conference room speaker", 1, 89.99),
        ("Standing desk mat", 1, 39.99),
        ("Whiteboard markers", 3, 11.49),
        ("Cable management box", 2, 24.99),
        ("Surge protector", 1, 18.99),
        ("Office chair wheels", 1, 32.99),
    ]
    random.shuffle(candidates)
    lowered = {p.lower() for p in prev_items}
    for name, qty, price in candidates:
        if name.lower() not in lowered:
            return CadabraOrder(item=name, quantity=qty, unit_price=price, total=qty * price)
    name, qty, price = candidates[0]
    return CadabraOrder(item=name, quantity=qty, unit_price=price, total=qty * price)


def _extract_prev_items(data: Dict[str, Any]) -> List[str]:
    items = []
    raw = data.get("cadabra_orders") or data.get("cadabraOrders") or []
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, str):
                val = entry.strip()
                if val:
                    items.append(val)
            elif isinstance(entry, dict):
                val = str(entry.get("item") or "").strip()
                if val:
                    items.append(val)
    # Deduplicate preserving order
    seen = set()
    uniq = []
    for val in items:
        key = val.lower()
        if key in seen:
            continue
        seen.add(key)
        uniq.append(val)
    return uniq


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

    company_ref = db.collection("companies").document(company_id)
    company_doc = company_ref.get()
    data = company_doc.to_dict() if company_doc.exists else {}
    company_desc = str(data.get("description") or "").strip()
    company_name = str(data.get("company_name") or company_id).strip()
    description = f"{company_name}: {company_desc}" if company_desc else company_name
    prev_items = _extract_prev_items(data)

    normalized: Dict[str, Any] | None = None
    try:
        parsed = _prompt_for_order(description, prev_items)
        normalized = _normalize(parsed)
        if normalized["item"].lower() in {p.lower() for p in prev_items}:
            # Try one more time to avoid duplication
            parsed = _prompt_for_order(description, prev_items + [normalized["item"]])
            normalized = _normalize(parsed)
    except (ValidationError, Exception):
        normalized = None
    if not normalized or normalized["item"].lower() in {p.lower() for p in prev_items}:
        normalized = _normalize(_fallback_order(prev_items))

    normalized["company"] = company_id

    try:
        updated = prev_items + [normalized["item"]]
        if len(updated) > 25:
            updated = updated[-25:]
        company_ref.set({"cadabra_orders": updated}, merge=True)
    except Exception:
        pass

    return func.HttpResponse(
        json.dumps(normalized),
        mimetype="application/json",
        status_code=200,
    )
