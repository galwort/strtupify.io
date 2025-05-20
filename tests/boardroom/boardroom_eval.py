import glob, json, statistics, os


def collect_metrics(data):
    ct = len(data)
    uc = len({x["company"]["name"] for x in data})
    msg_counts = [len(x["boardroom"]) for x in data]
    uniq_speakers = [len({m["speaker"] for m in x["boardroom"]}) for x in data]
    msg_lens = [len(m["msg"]) for x in data for m in x["boardroom"]]
    weights = [w for x in data for m in x["boardroom"] for w in m["weights"].values()]
    prod_lens = [len(x["product"]) for x in data]
    desc_lens = [len(x["description"]) for x in data]

    return [
        ct,
        uc,
        statistics.mean(msg_counts),
        statistics.median(msg_counts),
        max(msg_counts),
        min(msg_counts),
        statistics.mean(uniq_speakers),
        statistics.mean(msg_lens),
        max(msg_lens),
        min(msg_lens),
        statistics.mean(weights),
        max(weights),
        min(weights),
        statistics.mean(prod_lens),
        max(prod_lens),
        min(prod_lens),
        statistics.mean(desc_lens),
        max(desc_lens),
        min(desc_lens),
    ]


metric_names = [
    "total companies",
    "unique companies",
    "avg messages",
    "median messages",
    "max messages",
    "min messages",
    "avg unique speakers",
    "avg msg length",
    "max msg length",
    "min msg length",
    "avg weight",
    "max weight",
    "min weight",
    "avg product length",
    "max product length",
    "min product length",
    "avg description length",
    "max description length",
    "min description length",
]

files = sorted(glob.glob("*output.json"))
results = {fname: collect_metrics(json.load(open(fname))) for fname in files}

col_w0 = max(len(m) for m in metric_names)
col_ws = [
    max(
        len(os.path.basename(f)),
        *(len(f"{v:.2f}") if isinstance(v, float) else len(str(v)) for v in results[f]),
    )
    for f in files
]

header = ["metric".ljust(col_w0)] + [
    os.path.basename(f).rjust(col_ws[i]) for i, f in enumerate(files)
]
print("  ".join(header))

for idx, metric in enumerate(metric_names):
    row = [metric.ljust(col_w0)]
    for i, f in enumerate(files):
        val = results[f][idx]
        cell = f"{val:.2f}" if isinstance(val, float) else str(val)
        row.append(cell.rjust(col_ws[i]))
    print("  ".join(row))
