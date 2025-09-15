import glob, json, statistics, os


def collect(data):
    ct = len(data)
    approvals = [bool(x.get("funding", {}).get("approved", False)) for x in data]
    amounts = [float(x.get("funding", {}).get("amount", 0) or 0) for x in data]
    payments = [float(x.get("funding", {}).get("first_payment", 0) or 0) for x in data]
    desc_lens = [len(x.get("company", {}).get("description", "")) for x in data]
    return [
        ct,
        sum(approvals),
        100 * sum(approvals) / ct if ct else 0,
        statistics.mean(amounts) if amounts else 0,
        statistics.median(amounts) if amounts else 0,
        max(amounts) if amounts else 0,
        min(amounts) if amounts else 0,
        statistics.mean(payments) if payments else 0,
        statistics.mean(desc_lens) if desc_lens else 0,
    ]


names = [
    "total scenarios",
    "approved count",
    "approval rate %",
    "avg amount",
    "median amount",
    "max amount",
    "min amount",
    "avg first payment",
    "avg description length",
]

files = sorted(glob.glob("*output.json"))
results = {fname: collect(json.load(open(fname, encoding="utf-8"))) for fname in files}

w0 = max(len(m) for m in names)
ws = [
    max(
        len(os.path.basename(f)),
        *(len(f"{v:.2f}") if isinstance(v, float) else len(str(v)) for v in results[f]),
    )
    for f in files
]

hdr = ["metric".ljust(w0)] + [os.path.basename(f).rjust(ws[i]) for i, f in enumerate(files)]
print("  ".join(hdr))

for idx, metric in enumerate(names):
    row = [metric.ljust(w0)]
    for i, f in enumerate(files):
        val = results[f][idx]
        cell = f"{val:.2f}" if isinstance(val, float) else str(val)
        row.append(cell.rjust(ws[i]))
    print("  ".join(row))

