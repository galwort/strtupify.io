import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from firebase_admin import credentials, initialize_app, firestore
import firebase_admin as fb
from openai import AzureOpenAI
from random import gauss, random
import json, datetime

vault="https://kv-strtupifyio.vault.azure.net/"
sc=SecretClient(vault_url=vault,credential=DefaultAzureCredential())
endpoint=sc.get_secret("AIEndpoint").value
key=sc.get_secret("AIKey").value
deployment=sc.get_secret("AIDeploymentMini").value
client=AzureOpenAI(api_version="2023-07-01-preview",azure_endpoint=endpoint,api_key=key)

cred=credentials.Certificate(json.loads(sc.get_secret("FirebaseSDK").value))
if not fb._apps:
    initialize_app(cred)
db=firestore.client()

role_weights={"Project Manager":0.8,"Designer":0.6,"Developer":0.5}

def load_product(company,product):
    ref=db.collection("companies").document(company).collection("products").document(product)
    doc=ref.get().to_dict()
    emps=[d.to_dict()|{"id":d.id} for d in db.collection("companies").document(company).collection("employees").where("hired","==",True).stream()]
    return ref,doc,emps

def base_confidence(emp):
    return role_weights.get(emp.get("title"),0.4)+gauss(0,0.05)

def choose_next_speaker(emps,history):
    spoken={}
    for h in history:
        spoken[h["speaker"]]=spoken.get(h["speaker"],0)+1
    best=None
    score=-1
    for e in emps:
        conf=base_confidence(e)/(1+spoken.get(e["name"],0))
        if conf>score and random()<conf:
            best,score=e,conf
    return best if best else emps[0]

def gen_agent_line(agent,history,directive):
    sys=f"You are {agent['name']}, a {agent['title']} at a brand-new startup. Personality: {agent['personality']}. Keep your sentences concise. The meeting goal is: {directive}. Begin EXACTLY one sentence."
    msgs=[{"role":"system","content":sys}]
    for h in history[-6:]:
        msgs.append({"role":"assistant","content":f"{h['speaker']}: {h['msg']}"})
    msgs.append({"role":"assistant","content":f"{agent['name']}:"})
    rsp=client.chat.completions.create(model=deployment,messages=msgs)
    return rsp.choices[0].message.content.strip()

def gen_outcome(history,current):
    sys="You are an observer filling out a JSON with the agreed product idea. Return ONLY the JSON."
    msgs=[{"role":"system","content":sys},{"role":"user","content":"\n".join(f"{h['speaker']}: {h['msg']}" for h in history[-20:])}]
    rsp=client.chat.completions.create(model=deployment,response_format={"type":"json_object"},messages=msgs)
    return json.loads(rsp.choices[0].message.content)

def append_line(ref,speaker,msg,system=False):
    ref.update({"boardroom":firestore.ArrayUnion([{"speaker":speaker,"msg":msg,"at":datetime.datetime.utcnow().isoformat(),"system":system}]),"updated":firestore.SERVER_TIMESTAMP})

def conversation_complete(outcome):
    return bool(outcome.get("name") and outcome.get("description"))

def main(req:func.HttpRequest)->func.HttpResponse:
    body=req.get_json()
    company=body["company"]
    product=body["product"]
    ref,doc,emps=load_product(company,product)
    history=doc["boardroom"]
    outcome=doc["outcome"]
    directive=doc["directive"]
    speaker=choose_next_speaker(emps,history)
    line=gen_agent_line(speaker,history,directive)
    append_line(ref,speaker["name"],line)
    history.append({"speaker":speaker["name"],"msg":line})
    outcome=gen_outcome(history,outcome)
    ref.update({"outcome":outcome})
    append_line(ref,"_system",json.dumps(outcome,indent=0),True)
    done=conversation_complete(outcome)
    return func.HttpResponse(json.dumps({"speaker":speaker["name"],"line":line,"outcome":outcome,"done":done}),mimetype="application/json")
