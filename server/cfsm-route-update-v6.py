#!/usr/bin/env python3
"""Daily IPv6 return-route probe for the three China carrier networks."""
import fcntl
import json
import os
import random
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from cfsm_route_core import route_type, merge_candidate, atomic_save
import time
from datetime import datetime, timezone
from pathlib import Path

NEXTTRACE = "/usr/local/bin/nexttrace"
BASE = Path("/var/lib/cfsm-return-route")
OUTPUT = BASE / "zhejiang-v6.json"
LOG = Path("/var/log/cfsm-route-update-v6.log")
LOCK = Path("/run/lock/cfsm-route-update-v6.lock")
TARGETS = {
    "telecom": "zj-ct-v6.ip.zstaticcdn.com",
    "unicom": "zj-cu-v6.ip.zstaticcdn.com",
    "mobile": "zj-cm-v6.ip.zstaticcdn.com",
}


def log(message):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(f"{datetime.now(timezone.utc).isoformat()} {message}\n")


def classify(carrier, hops):
    asns = set()
    for group in hops:
        if isinstance(group, list):
            for item in group:
                if item.get("Success"):
                    asns.add(str((item.get("Geo") or {}).get("asnumber") or ""))
    return route_type(carrier, asns)


def format_route_path(hops):
    """Preserve observed ASN hops, per-TTL ECMP alternatives, and nonresponsive gaps."""
    labels = []
    for group in hops:
        if not isinstance(group, list) or not group:
            labels.append("*")
            continue
        observed = []
        for item in group:
            if not item.get("Success"):
                continue
            geo = item.get("Geo") or {}
            raw_asn = str(geo.get("asnumber") or "").strip()
            asn = raw_asn if raw_asn.isdigit() else ""
            tag = ""
            if asn == "4809": tag = "CN2"
            elif asn == "4134": tag = "163"
            elif asn == "9929": tag = "9929"
            elif asn == "10099": tag = "10099"
            elif asn == "4837": tag = "4837"
            elif asn == "58807": tag = "CMIN2"
            elif asn == "58453": tag = "CMI"
            elif asn in {"9808", "56041"}: tag = "CMNET"
            if asn:
                observed.append("AS%s%s" % (asn, " (%s)" % tag if tag else ""))
            else:
                owner = str(geo.get("isp") or geo.get("owner") or "ASN 未识别").strip()
                observed.append(owner[:36])
        labels.append(" / ".join(sorted(set(observed))) if observed else "*")

    compact = []
    for label in labels:
        if compact and compact[-1][0] == label:
            compact[-1][1] += 1
        else:
            compact.append([label, 1])
    path = " → ".join("%s ×%d" % (label, count) if count > 1 else label for label, count in compact)
    return path[:1200]


def probe(carrier, hostname):
    command = [NEXTTRACE, "-6", "--tcp", "-p", "80", "-q", "3", "--psize", "1400", "--max-hops", "30", "-j", hostname]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=70)
    except Exception as error:
        log(f"{carrier} probe_error={type(error).__name__}")
        return None
    start = result.stdout.find("{")
    if result.returncode != 0 or start < 0:
        log(f"{carrier} trace_failed exit={result.returncode}")
        return None
    try:
        data = json.JSONDecoder().raw_decode(result.stdout[start:])[0]
    except Exception:
        log(f"{carrier} invalid_json")
        return None
    stop = data.get("StopReason") or {}
    if stop.get("reason") != "destination_reached":
        log(f"{carrier} destination_not_reached")
        return None
    route = classify(carrier, data.get("Hops") or [])
    if not route:
        log(f"{carrier} no_backbone_evidence")
        return None
    return {"route": route, "route_type": route, "route_path": format_route_path(data.get("Hops") or []),
            "confidence": "high", "destination_reached": True,
            "reason": "destination reached; ASN evidence", "target": hostname}


def main():
    if not Path(NEXTTRACE).is_file():
        log("ERROR nexttrace_missing")
        return 1
    BASE.mkdir(parents=True, exist_ok=True)
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with LOCK.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("SKIP already_running")
            return 0
        if os.environ.get("CFSM_NO_JITTER") != "1":
            time.sleep(random.randint(0, 300))
        def with_retry(item):
            carrier, target = item
            return carrier, probe(carrier, target) or probe(carrier, target)
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = dict(pool.map(with_retry, TARGETS.items()))
        try:
            value = json.loads(OUTPUT.read_text())
        except Exception:
            value = {}
        stamp = datetime.now(timezone.utc).isoformat()
        updated = sum(merge_candidate(value, carrier, results.get(carrier), stamp) for carrier in TARGETS)
        value.update(region="浙江", source="服务器每日 IPv6 回程探针", method="nexttrace-ipv6-tcp-v3", last_attempt_at=stamp)
        atomic_save(OUTPUT, value)
        log(f"FINISH updated={updated}/3")
    return 0


if __name__ == "__main__":
    sys.exit(main())
