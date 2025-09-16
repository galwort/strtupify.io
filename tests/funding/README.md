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
  --url https://fa-strtupifyio.azurewebsites.net/api/funding \
  --diversity 0.85 --max-tries 6 \
  --avoid-terms "eco,pack,packaging,sustainable,biodegradable,compostable,eco-friendly"

# Networking resilience (optional)

Add retry/backoff tuning if you see mid-run connection resets:

```
python generate_and_test.py --count 50 --outfile output.json \
  --url https://fa-strtupifyio.azurewebsites.net/api/funding \
  --http-retries 6 --http-attempts 6 --http-timeout 60 \
  --http-backoff 0.75 --sleep 0.6
```
```

Environment must have access to Key Vault `kv-strtupifyio` for `AIEndpoint`, `AIKey`, `AIDeploymentMini`, and `AIDeploymentEmbedding`.
