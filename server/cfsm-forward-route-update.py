#!/usr/bin/env python3
"""Daily IPv4/IPv6 three-carrier forward-route scan via public TCPTest nodes."""
import fcntl
import json
import os
import random
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from cfsm_route_core import route_type, merge_candidate

API = "https://www.tcptest.cn/api/v2"
BASE = Path("/var/lib/cfsm-forward-route")
OUTPUT = BASE / "routes.json"
LOG = Path("/var/log/cfsm-forward-route-update.log")
LOCK = Path("/run/lock/cfsm-forward-route-update.lock")
CARRIERS = {
    "telecom": "e88712a7-5da2-45fe-a22b-97dc5c62600b",
    "unicom": "5616de3a-0f66-4d3c-9508-47dc081a650c",
    "mobile": "9b35c875-3d28-4345-a82b-343b916791d9",
}
CARRIER_REGIONS = {
    "telecom": "浙江温州电信第三方探测点",
    "unicom": "浙江温州联通第三方探测点",
    "mobile": "浙江宁波移动第三方探测点",
}
SERVERS = {
    "218776b9-adda-404f-a34a-7673c43a8c3a": ("45.142.125.101", "2a12:a301:2001::10dd"),
    "6d63ca9f-9064-4774-a569-61b718e7443d": ("207.57.142.44", "2602:f656:5::2a3"),
    "e4ab883d-ef3a-46ff-8468-f5800e93f5b1": ("24.249.30.16", "2001:57a:f200:b920::18f"),
}
TRANSIT_LABELS = {"3257": "GTT", "1299": "Arelion", "3356": "Lumen", "17676": "SoftBank", "22773": "Cox"}
AS_LABELS = {
    "telecom": {"4809": "CN2", "4134": "163", "136190": "CT"},
    "unicom": {"9929": "9929", "10099": "10099", "4837": "4837"},
    "mobile": {"58807": "CMIN2", "58453": "CMI", "9808": "CMI", "56041": "CMI"},
}


def log(message):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(f"{datetime.now(timezone.utc).isoformat()} {message}\n")


def request_json(url, body=None, timeout=15):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"User-Agent": "Mozilla/5.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def load_nodes():
    nodes, cursor = {}, 0
    try:
        for _ in range(8):
            response = request_json(f"https://www.tcptest.cn/api/v1/nodes?after={cursor}&limit=100")
            for node in response.get("nodes", []):
                nodes[node.get("uuid")] = node
            if all(uuid in nodes for uuid in CARRIERS.values()) or not response.get("has_more"):
                return nodes
            next_cursor = response.get("next_cursor")
            if not isinstance(next_cursor, int) or next_cursor <= cursor:
                return None
            cursor = next_cursor
    except Exception as error:
        log(f"NODE_PREFLIGHT unavailable={type(error).__name__}; final task success remains required")
    return None


def node_available(node, family):
    return bool(node and node.get("enabled") is True and node.get("runtime_state") == "online"
                and (node.get("capabilities") or {}).get("traceroute") is True
                and (family != "ipv6" or (node.get("capabilities") or {}).get("ipv6") is True))


def create_task(task):
    if task.get("node_checked") and not node_available(task.get("node"), task["family"]):
        log(f"SUBMIT {task['family']} {task['carrier']} skipped=node_unavailable")
        return None
    body = {
        "type": "traceroute",
        "target": task["target"],
        "ip_family": task["family"],
        "node_filter": {"node_uuids": [CARRIERS[task["carrier"]]], "limit": 1},
        "options": {"max_hops": 30, "rounds": 1},
    }
    try:
        response = request_json(f"{API}/tasks", body, timeout=20)
        task["task_id"] = response.get("id")
        if not task["task_id"]:
            raise RuntimeError("missing_task_id")
        return task
    except Exception as error:
        log(f"SUBMIT {task['server_id']} {task['family']} {task['carrier']} failed={type(error).__name__}")
        return None


def summarize(result, carrier):
    if result.get("success") is not True:
        return None
    data = result.get("data") or {}
    hops = data.get("hops")
    if not isinstance(hops, list):
        return None
    labels, asns = [], set()
    cn2_prefix = False
    # Explicit international/transit evidence; domestic access ASNs do not qualify.
    international = {"4809", "9929", "10099", "58807", "58453", *TRANSIT_LABELS,
                     "21859", "7578", "137409", "136510"}
    for hop in hops:
        asn = str(hop.get("asn") or "").upper().removeprefix("AS")
        asns.add(asn)
        if carrier == "telecom" and str(hop.get("ip") or "").startswith("59.43."):
            cn2_prefix = True
            label = "CN2"
        elif asn:
            label = AS_LABELS[carrier].get(asn, TRANSIT_LABELS.get(asn, f"AS{asn}"))
        else:
            continue
        if labels[-1:] != [label]:
            labels.append(label)
    kind = route_type(carrier, asns, cn2_prefix)
    if not labels or not kind or not (asns & international or cn2_prefix):
        return None
    return {"route": " → ".join(labels)[:160], "route_type": kind,
            "confidence": "medium", "reason": "observed backbone/transit ASN evidence"}


def poll_task(task):
    try:
        response = request_json(f"{API}/tasks/{task['task_id']}/results?after=0&limit=100", timeout=15)
        final = next((item for item in response.get("results", []) if item.get("final")), None)
        if final is None:
            return None
        candidate = summarize(final, task["carrier"])
        if candidate:
            candidate["region"] = task["region"]
            candidate["source"] = "TCPTest 每日自动路由探测"
        return {**task, "candidate": candidate}
    except Exception:
        return None


def atomic_save(value):
    BASE.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="routes.", dir=str(BASE))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, OUTPUT)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
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

        server_id = Path("/etc/cfsm-forward-route-server-id").read_text().strip()
        if server_id not in SERVERS:
            raise SystemExit("unknown_local_server_id")
        tasks = []
        for server_id, addresses in [(server_id, SERVERS[server_id])]:
            families = [("ipv4", addresses[0]), ("ipv6", addresses[1])]
            for family, target in families:
                for carrier in CARRIERS:
                    tasks.append({"server_id": server_id, "family": family, "carrier": carrier, "target": target,
                                  "region": CARRIER_REGIONS[carrier]})
        nodes = load_nodes()
        for task in tasks:
            task["node_checked"] = nodes is not None
            task["node"] = (nodes or {}).get(CARRIERS[task["carrier"]])
        created = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(create_task, task) for task in tasks]
            for future in as_completed(futures):
                task = future.result()
                if task:
                    created.append(task)
        if not created:
            log("REJECT no_tasks_created; cached routes kept")

        pending = {task["task_id"]: task for task in created}
        results = []
        deadline = time.monotonic() + 240
        while pending and time.monotonic() < deadline:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(poll_task, task) for task in pending.values()]
                finished = [future.result() for future in as_completed(futures)]
            for item in finished:
                if item:
                    results.append(item)
                    pending.pop(item["task_id"], None)
            if pending:
                time.sleep(8)

        retry_tasks = [{k: v for k, v in task.items() if k != "task_id"}
                       for task in created if not any(item["task_id"] == task["task_id"] and item.get("candidate") for item in results)]
        with ThreadPoolExecutor(max_workers=3) as pool:
            retries = [task for task in pool.map(create_task, retry_tasks) if task]
        retry_pending = {task["task_id"]: task for task in retries}
        retry_deadline = time.monotonic() + 120
        while retry_pending and time.monotonic() < retry_deadline:
            with ThreadPoolExecutor(max_workers=6) as pool:
                finished = list(pool.map(poll_task, list(retry_pending.values())))
            for item in finished:
                if item:
                    # Replace the first failed observation, never count a retry as a new daily confirmation.
                    results = [r for r in results if (r["family"], r["carrier"]) != (item["family"], item["carrier"])]
                    results.append(item)
                    retry_pending.pop(item["task_id"], None)
            if retry_pending:
                time.sleep(8)

        try:
            cached = json.loads(OUTPUT.read_text(encoding="utf-8"))
        except Exception:
            cached = {"ipv4": {}, "ipv6": {}}
        stamp = datetime.now(timezone.utc).isoformat()
        changed = 0
        by_key = {(item["family"], item["carrier"]): item.get("candidate") for item in results}
        for task in tasks:
            family = cached.setdefault(task["family"], {})
            changed += merge_candidate(family, task["carrier"], by_key.get((task["family"], task["carrier"])), stamp)
            family.update(region="浙江三网第三方探测点", source="TCPTest 每日自动路由探测", last_attempt_at=stamp)
        atomic_save(cached)
        log(f"FINISH submitted={len(created)}/{len(tasks)} results={len(results)} routes_updated={changed} pending={len(pending) + len(retry_pending)} retry_submitted={len(retries)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
