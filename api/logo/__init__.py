import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from azure.storage.blob import BlobServiceClient
from openai import AzureOpenAI
from pickle import load
from scipy.spatial import distance

vault_url = "https://kv-strtupifyio.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)
container_connection_str = secret_client.get_secret("StorageConnectionString").value
endpoint = secret_client.get_secret("AIEndpoint").value
api_key = secret_client.get_secret("AIKey").value
model = secret_client.get_secret("AIDeployment").value
minimodel = secret_client.get_secret("AIDeploymentMini").value
embeddingmodel = secret_client.get_secret("AIDeploymentEmbedding").value


client = AzureOpenAI(
    api_version="2024-08-01-preview",
    azure_endpoint=endpoint,
    api_key=api_key,
)


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        req_body = req.get_json()
        input = req_body.get("input")
        blob_service_client = BlobServiceClient.from_connection_string(
            container_connection_str
        )
        container_client = blob_service_client.get_container_client("assets")
        blob_client = container_client.get_blob_client("icon_embeddings.pkl")
        icon_embeddings = load(blob_client.download_blob().readall())
        phrase_embedding = (
            client.embeddings.create(
                model=embeddingmodel,
                input=input,
            )
            .data[0]
            .embedding
        )

        min_distance = float("inf")
        logo = None

        for icon, embedding in icon_embeddings.items():
            dist = distance.cosine(phrase_embedding, embedding)
            if dist < min_distance:
                min_distance = dist
                logo = icon

        return func.HttpResponse(logo, status_code=200)

    except Exception as e:
        return func.HttpResponse(f"Error processing request: {str(e)}", status_code=500)
