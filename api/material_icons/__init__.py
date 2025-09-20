import azure.functions as func
from json import dumps

try:

    from urllib.request import urlopen
except ImportError:
    urlopen = None


def main(req: func.HttpRequest) -> func.HttpResponse:
    icons = []
    status = 200
    try:
        if urlopen is None:
            raise RuntimeError("urllib unavailable")
        with urlopen("https://fonts.google.com/metadata/icons", timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")

            if raw.startswith(")]}\'"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[4:]
            import json

            data = json.loads(raw)
            icons = sorted({i.get("name") for i in (data.get("icons") or []) if i.get("name")})
    except Exception:

        status = 200
        icons = []

    body = dumps({"icons": icons})
    return func.HttpResponse(
        body,
        mimetype="application/json",
        status_code=status,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        },
    )

