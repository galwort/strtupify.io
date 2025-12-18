import azure.functions as func
import logging
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from azure.storage.blob import BlobServiceClient
from typing import Optional

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

DEFAULT_CONTAINER = "avatars"
ALLOWED_CONTAINERS = {DEFAULT_CONTAINER, "consultants"}

try:
    storage_connection = secret_client.get_secret("StorageConnectionString").value
    blob_service_client = BlobServiceClient.from_connection_string(storage_connection)
except Exception as e:
    logging.error(f"Failed to initialize avatar storage client: {e}", exc_info=True)
    blob_service_client = None

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
}


def _get_container(container: Optional[str]):
    if blob_service_client is None:
        return None
    target = (container or DEFAULT_CONTAINER).strip().lower() or DEFAULT_CONTAINER
    if target not in ALLOWED_CONTAINERS:
        target = DEFAULT_CONTAINER
    try:
        return blob_service_client.get_container_client(target)
    except Exception as e:
        logging.error(f"Failed to get container client for {target}: {e}", exc_info=True)
        return None


def _normalize_blob_name(name: str, mood: Optional[str], apply_mood: bool = True) -> str:
    if not name:
        return ""
    base = name.strip()
    if base.lower().endswith(".svg"):
        base = base[:-4]
    if not apply_mood:
        return f"{base}.svg"
    mood_value = (mood or "neutral").strip().lower() or "neutral"
    if not base.lower().endswith(
        ("_neutral", "_happy", "_sad", "_angry")
    ):
        base = f"{base}_{mood_value}"
    return f"{base}.svg"


def main(req: func.HttpRequest) -> func.HttpResponse:
    if req.method.lower() == "options":
        return func.HttpResponse(
            "",
            status_code=200,
            headers=CORS_HEADERS,
        )

    if blob_service_client is None:
        return func.HttpResponse(
            "Avatar storage is unavailable", status_code=500, headers=CORS_HEADERS
        )

    params = req.params or {}
    name = params.get("name") or params.get("avatar") or ""
    mood = params.get("mood") or params.get("state") or "neutral"
    container = params.get("container") or params.get("bucket") or ""

    if not name:
        try:
            data = req.get_json()
            name = data.get("name") or data.get("avatar") or ""
            mood = data.get("mood") or mood or "neutral"
            container = data.get("container") or container
        except Exception:
            pass

    apply_mood = (container or DEFAULT_CONTAINER).strip().lower() != "consultants"
    blob_name = _normalize_blob_name(name, mood, apply_mood)
    if not blob_name:
        return func.HttpResponse(
            "Missing avatar name", status_code=400, headers=CORS_HEADERS
        )

    target_container = _get_container(container)
    if target_container is None:
        return func.HttpResponse(
            "Avatar storage is unavailable", status_code=500, headers=CORS_HEADERS
        )

    try:
        blob_client = target_container.get_blob_client(blob_name)
        blob_data = blob_client.download_blob().readall()
    except Exception as e:
        logging.warning(f"Avatar not found: {blob_name} in {target_container.container_name} ({e})")
        return func.HttpResponse("Avatar not found", status_code=404, headers=CORS_HEADERS)

    return func.HttpResponse(
        blob_data,
        status_code=200,
        mimetype="image/svg+xml",
        headers={
            **CORS_HEADERS,
            "Cache-Control": "public, max-age=86400",
        },
    )
