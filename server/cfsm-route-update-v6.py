#!/usr/bin/env python3
"""Daily IPv6 return-route probe for the three China carrier networks."""
import fcntl
import json
import os
import random
import subprocess
import sys
import tempfile
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
    seen = set()
    texts = []
    for group in hops:
        if not isinstance(group, list):
            continue
        for item in group:
            if not item.get("Success"):
                continue
            geo = item.get("Geo") or {}
            asn = str(geo.get("asnumber") or "").removeprefix("AS")
            if asn:
                seen.add(asn)
            texts.extend((str(geo.get("isp") or ""), str(geo.get("owner") or "")))
    joined = " ".join(texts).lower()
    if carrier == "telecom":
        if "4809" in seen or "cn2" in joined:
            return "CN2"
        if "4134" in seen or "china telecom backbone" in joined or "中国电信" in joined:
            return "普通国际"
    elif carrier == "unicom":
        if "9929" in seen or "cuii" in joined:
            return "9929"
        if "10099" in seen or "cug-backbone" in joined:
            return "10099"
        if "4837" in seen or "china169" in joined:
            return "4837"
    elif carrier == "mobile":
        if "58807" in seen or "cmi n2" in joined or "中移国际" in joined:
            return "CMIN2"
        if {"58453", "9808", "56041"} & seen or "cmnet" in joined or "china mobile" in joined:
            return "CMI"
    return None


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
    return {"route": route, "target": hostname}


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
        results = {carrier: probe(carrier, target) for carrier, target in TARGETS.items()}
        if not all(results.values()):
            log("REJECT incomplete_probe_set; cached data kept")
            return 0
        value = {
            "region": "浙江",
            "telecom": results["telecom"]["route"],
            "unicom": results["unicom"]["route"],
            "mobile": results["mobile"]["route"],
            "probed_at": datetime.now(timezone.utc).isoformat(),
            "method": "nexttrace-ipv6-tcp",
        }
        fd, temp_name = tempfile.mkstemp(prefix="zhejiang-v6.", dir=str(BASE))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, OUTPUT)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        log("UPDATED all_three_carriers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
