# Funding tests

- Generates diverse company scenarios with Azure OpenAI
- Calls the deployed funding function for each scenario
- Stores results in `output.json`

## Setup

```
python -m venv .venv
. .venv/bin/activate  # or .venv\\Scripts\\activate on Windows
pip install -r requirements.txt
```

## Run

```
python generate_and_test.py --count 50 --outfile output.json \
  --url https://fa-strtupifyio.azurewebsites.net/api/funding
```

Environment must have access to Key Vault `kv-strtupifyio` for `AIEndpoint`, `AIKey`, `AIDeploymentMini`.
