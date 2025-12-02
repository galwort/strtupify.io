import azure.functions as func
import logging
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import AzureOpenAI
from scipy.spatial import distance
import json
from typing import Any, Dict, List, Tuple
from urllib.request import urlopen

logging.basicConfig(level=logging.INFO)

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()

try:
    logging.info("Initializing Key Vault client...")
    secret_client = SecretClient(vault_url=vault_url, credential=credential)

    logging.info("Fetching secrets from Key Vault...")
    endpoint = secret_client.get_secret("AIEndpoint").value
    api_key = secret_client.get_secret("AIKey").value
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

material_icon_embeddings: Dict[str, List[float]] = {}
material_icon_names: List[str] = []
material_embeddings_loaded = False


def load_material_embeddings() -> Dict[str, List[float]]:
    global material_icon_embeddings, material_icon_names, material_embeddings_loaded
    if material_embeddings_loaded and material_icon_embeddings:
        return material_icon_embeddings

    try:
        logging.info("Fetching Material icons metadata...")
        raw = urlopen("https://fonts.google.com/metadata/icons", timeout=10).read().decode(
            "utf-8", errors="ignore"
        )
        if raw.startswith(")]}'"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[4:]
        data = json.loads(raw)
        icons = data.get("icons") or []
        material_icon_names = [i.get("name") for i in icons if i.get("name")]
        if not material_icon_names:
            logging.warning("No Material icons found in metadata.")
            material_embeddings_loaded = True
            return {}

        logging.info(f"Embedding {len(material_icon_names)} Material icons...")
        embeddings: Dict[str, List[float]] = {}
        batch_size = 128
        for start in range(0, len(material_icon_names), batch_size):
            batch = material_icon_names[start : start + batch_size]
            emb_resp = client.embeddings.create(model=embeddingmodel, input=batch)
            for name, emb in zip(batch, emb_resp.data):
                embeddings[name] = emb.embedding
        material_icon_embeddings = embeddings
        material_embeddings_loaded = True
        logging.info(f"Material embeddings loaded: {len(material_icon_embeddings)} icons.")
        return embeddings
    except Exception as e:
        logging.error(f"Error loading material embeddings: {str(e)}", exc_info=True)
        material_embeddings_loaded = True
        return {}


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

        limit = None
        if limit_raw is not None:
            try:
                parsed_limit = int(limit_raw)
                if parsed_limit > 0:
                    limit = max(1, parsed_limit)
            except Exception:
                limit = None

        # Always use in-memory Material icon embeddings so we return the full catalog.
        icon_embeddings = load_material_embeddings()
        if not icon_embeddings:
            logging.warning("No embeddings available after load.")
            return func.HttpResponse("No embeddings available.", status_code=500)

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

        if limit:
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
