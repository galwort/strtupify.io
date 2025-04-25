import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
from openai import AzureOpenAI
from random import gauss, random
import json, uuid

vault="https://kv-strtupifyio.vault.azure.net/"
sc=SecretClient(vault_url=vault,credential=DefaultAzureCredential())
endpoint=sc.get_secret("AIEndpoint").value
key=sc.get_secret("AIKey").value
deployment=sc.get_secret("AIDeploymentMini").value
client=AzureOpenAI(api_version="2023-07-01-preview",azure_endpoint=endpoint,api_key=key)

cred=credentials.Certificate(json.loads(sc.get_secret("FirebaseSDK").value))
initialize_app(cred)
db=firestore.client()

role_weights={"Project Manager":0.8,"Designer":0.6,"Developer":0.5}

def load_employees(company):
    docs=db.collection("companies").document(company).collection("employees").where("hired","==",True).stream()
    return [d.to_dict()|{"id":d.id} for d in docs]

def base_confidence(emp):
    return role_weights.get(emp.get("title"),0.4)+gauss(0,0.05)

def pick_first_speaker(emps):
    return max(emps,key=base_confidence)

def gen_agent_line(agent,history,directive):
    sys=f"You are {agent['name']}, a {agent['title']} at a brand-new startup. Personality: {agent['personality']}. Keep your sentences concise. The meeting goal is: {directive}. Begin EXACTLY one sentence."
    msgs=[{"role":"system","content":sys}]
    for h in history[-6:]:
        msgs.append({"role":"assistant","content":f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role":"assistant","content":f"{agent['name']}:"})
    rsp=client.chat.completions.create(model=deployment,messages=msgs)
    return rsp.choices[0].message.content.strip()

def store_product(company,speaker,line,directive):
    ref=db.collection("companies").document(company).collection("products").document(str(uuid.uuid4()))
    ref.set({"boardroom":[{"speaker":speaker,"msg":line}],"outcome":{"name":"","description":""},"directive":directive,"created":firestore.SERVER_TIMESTAMP,"updated":firestore.SERVER_TIMESTAMP})
    return ref.id

def main(req:func.HttpRequest)->func.HttpResponse:
    body=req.get_json()
    company=body["company"]
    directive=body.get("directive","Come up with the company’s first product")
    emps=load_employees(company)
    if not emps:
        return func.HttpResponse(json.dumps({"error":"no employees"}),status_code=400)
    speaker=pick_first_speaker(emps)
    line=gen_agent_line(speaker,[],directive)
    product_id=store_product(company,speaker["name"],line,directive)
    return func.HttpResponse(json.dumps({"productId":product_id,"speaker":speaker["name"],"line":line}),mimetype="application/json")
