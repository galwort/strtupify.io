import glob, json, statistics, os

def collect_metrics(data):
    ct = len(data)
    uc = len({x["company"]["name"] for x in data})
    msg_counts = [len(x["boardroom"]) for x in data]
    amsg = sum(msg_counts) / len(msg_counts)
    mmsg = statistics.median(msg_counts)
    maxmsg = max(msg_counts)
    minmsg = min(msg_counts)
    uniq_speakers = [len({m["speaker"] for m in x["boardroom"]}) for x in data]
    auspk = sum(uniq_speakers) / len(uniq_speakers)
    msg_lens = [len(m["msg"]) for x in data for m in x["boardroom"]]
    amlen = sum(msg_lens) / len(msg_lens)
    maxmlen = max(msg_lens)
    minmlen = min(msg_lens)
    weights = [w for x in data for m in x["boardroom"] for w in m["weights"].values()]
    awgt = sum(weights) / len(weights)
    maxwgt = max(weights)
    minwgt = min(weights)
    prod_lens = [len(x["product"]) for x in data]
    aplen = sum(prod_lens) / len(prod_lens)
    maxplen = max(prod_lens)
    minplen = min(prod_lens)
    desc_lens = [len(x["description"]) for x in data]
    adlen = sum(desc_lens) / len(desc_lens)
    maxdlen = max(desc_lens)
    mindlen = min(desc_lens)
    return [
        ct, uc, amsg, mmsg, maxmsg, minmsg,
        auspk, amlen, maxmlen, minmlen,
        awgt, maxwgt, minwgt,
        aplen, maxplen, minplen,
        adlen, maxdlen, mindlen,
    ]

metrics = [
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
results = {f: collect_metrics(json.load(open(f))) for f in files}

print("\t".join(["metric"] + [os.path.basename(f) for f in files]))
for i, name in enumerate(metrics):
    row = [name] + [
        f"{results[f][i]:.2f}" if isinstance(results[f][i], float) else str(results[f][i])
        for f in files
    ]
    print("\t".join(row))
