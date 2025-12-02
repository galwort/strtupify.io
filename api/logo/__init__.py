import azure.functions as func
import logging
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from azure.storage.blob import BlobServiceClient
from openai import AzureOpenAI
from pickle import loads
from scipy.spatial import distance
import json
from typing import Any, Dict, List, Tuple

logging.basicConfig(level=logging.INFO)

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()

try:
    logging.info("Initializing Key Vault client...")
    secret_client = SecretClient(vault_url=vault_url, credential=credential)

    logging.info("Fetching secrets from Key Vault...")
    container_connection_str = secret_client.get_secret("StorageConnectionString").value
    endpoint = secret_client.get_secret("AIEndpoint").value
    api_key = secret_client.get_secret("AIKey").value
    model = secret_client.get_secret("AIDeployment").value
    minimodel = secret_client.get_secret("AIDeploymentMini").value
    embeddingmodel = secret_client.get_secret("AIDeploymentEmbedding").value

    logging.info("Initializing OpenAI client...")
    client = AzureOpenAI(
        api_version="2024-08-01-preview",
        azure_endpoint=endpoint,
        api_key=api_key,
    )

except Exception as e:
    logging.error(f"Error during initialization: {str(e)}")
    raise


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Function triggered.")

    try:
        req_body = req.get_json()
        input_text = req_body.get("input")
        min_score_raw = req_body.get("min_score", None)
        limit_raw = req_body.get("limit", None)
        if not input_text:
            logging.error("Missing 'input' in request body.")
            return func.HttpResponse("Missing 'input' in request body", status_code=400)

        try:
            min_score = float(min_score_raw) if min_score_raw is not None else None
            if min_score is not None:
                min_score = max(0.0, min(1.0, min_score))
        except Exception:
            min_score = None

        try:
            limit = int(limit_raw) if limit_raw is not None else 1
        except Exception:
            limit = 1
        limit = max(1, min(50, limit))

        logging.info("Fetching Blob Storage connection...")
        blob_service_client = BlobServiceClient.from_connection_string(
            container_connection_str
        )
        container_client = blob_service_client.get_container_client("assets")

        logging.info("Fetching icon embeddings from Blob Storage...")
        blob_client = container_client.get_blob_client("icon_embeddings.pkl")

        blob_data = blob_client.download_blob().readall()
        logging.info(f"Blob Size: {len(blob_data)} bytes")

        try:
            icon_embeddings = loads(blob_data)
            logging.info("Successfully loaded embeddings from pickle file.")
        except Exception as e:
            logging.error(f"Error loading pickle file: {str(e)}")
            return func.HttpResponse(
                f"Error loading embeddings: {str(e)}", status_code=500
            )

        logging.info("Fetching embedding for input text...")
        try:
            phrase_embedding = (
                client.embeddings.create(model=embeddingmodel, input=input_text)
                .data[0]
                .embedding
            )
        except Exception as e:
            logging.error(f"Error generating embedding: {str(e)}")
            return func.HttpResponse(
                f"Error generating embedding: {str(e)}", status_code=500
            )

        logging.info("Calculating cosine similarity...")
        scored: List[Tuple[str, float]] = []

        for icon, embedding in icon_embeddings.items():
            try:
                dist = distance.cosine(phrase_embedding, embedding)
                score = 1 - dist
                scored.append((icon, score))
            except Exception as e:
                logging.warning(f"Error calculating distance for {icon}: {str(e)}")

        if not scored:
            logging.warning("No suitable match found.")
            return func.HttpResponse("No suitable match found.", status_code=404)

        scored.sort(key=lambda x: x[1], reverse=True)
        best_icon, best_score = scored[0]

        filtered = [
            {"icon": icon, "score": score}
            for icon, score in scored
            if (min_score is None or score >= min_score)
        ]

        filtered = filtered[:limit]

        response_body: Dict[str, Any] = {
            "best": best_icon,
            "best_score": best_score,
            "matches": filtered,
        }

        logging.info(f"Returning {len(filtered)} matches (best: {best_icon})")
        return func.HttpResponse(
            json.dumps(response_body),
            status_code=200,
            mimetype="application/json",
        )

    except Exception as e:
        logging.error(f"Unexpected error: {str(e)}", exc_info=True)
        return func.HttpResponse(f"Error processing request: {str(e)}", status_code=500)
