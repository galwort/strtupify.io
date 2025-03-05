import azure.functions as func
from json import dumps, loads
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from openai import OpenAI

vault_url = "https://kv-galwort.vault.azure.net/"
credential = DefaultAzureCredential()
secret_client = SecretClient(vault_url=vault_url, credential=credential)
client = OpenAI(api_key=secret_client.get_secret("OAIKey").value)


def gen_personality(name):
    system_message = (
        "You are a personality generator. When given the name of a person, "
        + "your task is to reply with a short, concise description of their personality. "
        + "The description should be no more than a couple of sentences. "
        + "Do not assume the gender of the person. "
        + "Reply in JSON format with the word 'personality' as the key, "
        + "and the description as the value."
    )

    messages = [{"role": "system", "content": system_message}]
    user_message = {"role": "user", "content": name}
    messages.append(user_message)

    response = client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=messages,
    )

    personality = loads(response.choices[0].message.content)["personality"]

    return personality


def main(req: func.HttpRequest) -> func.HttpResponse:
    req_body = req.get_json()
    name = req_body["name"]

    personality = gen_personality(name)

    return func.HttpResponse(
        dumps({"personality": personality}), mimetype="application/json"
    )
