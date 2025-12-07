import azure.functions as func
import logging
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from azure.storage.blob import BlobServiceClient
from typing import Optional

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)

try:
    storage_connection = secret_client.get_secret("StorageConnectionString").value
    blob_service_client = BlobServiceClient.from_connection_string(storage_connection)
    avatar_container = blob_service_client.get_container_client("avatars")
except Exception as e:
    logging.error(f"Failed to initialize avatar storage client: {e}", exc_info=True)
    avatar_container = None

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
}


def _normalize_blob_name(name: str, mood: Optional[str]) -> str:
    if not name:
        return ""
    base = name.strip()
    if base.lower().endswith(".svg"):
        base = base[:-4]
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

    if avatar_container is None:
        return func.HttpResponse(
            "Avatar storage is unavailable", status_code=500, headers=CORS_HEADERS
        )

    params = req.params or {}
    name = params.get("name") or params.get("avatar") or ""
    mood = params.get("mood") or params.get("state") or "neutral"

    if not name:
        try:
            data = req.get_json()
            name = data.get("name") or data.get("avatar") or ""
            mood = data.get("mood") or mood or "neutral"
        except Exception:
            pass

    blob_name = _normalize_blob_name(name, mood)
    if not blob_name:
        return func.HttpResponse(
            "Missing avatar name", status_code=400, headers=CORS_HEADERS
        )

    try:
        blob_client = avatar_container.get_blob_client(blob_name)
        blob_data = blob_client.download_blob().readall()
    except Exception as e:
        logging.warning(f"Avatar not found: {blob_name} ({e})")
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
