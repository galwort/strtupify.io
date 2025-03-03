import azure.functions as func
import logging
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from azure.storage.blob import BlobServiceClient
from openai import AzureOpenAI
from pickle import loads
from scipy.spatial import distance

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
        if not input_text:
            logging.error("Missing 'input' in request body.")
            return func.HttpResponse("Missing 'input' in request body", status_code=400)

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

        logging.info("Calculating cosine distance...")
        min_distance = float("inf")
        logo = None

        for icon, embedding in icon_embeddings.items():
            try:
                dist = distance.cosine(phrase_embedding, embedding)
                if dist < min_distance:
                    min_distance = dist
                    logo = icon
            except Exception as e:
                logging.warning(f"Error calculating distance for {icon}: {str(e)}")

        if logo is None:
            logging.warning("No suitable match found.")
            return func.HttpResponse("No suitable match found.", status_code=404)

        logging.info(f"Returning closest match: {logo}")
        return func.HttpResponse(logo, status_code=200)

    except Exception as e:
        logging.error(f"Unexpected error: {str(e)}", exc_info=True)
        return func.HttpResponse(f"Error processing request: {str(e)}", status_code=500)
