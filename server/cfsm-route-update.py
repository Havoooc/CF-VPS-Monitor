#!/usr/bin/env python3
"""Daily IPv4 updater; merge successful carriers without refreshing stale clocks."""
import fcntl
import json
import os
import random
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from cfsm_route_core import CARRIERS, merge_candidate, atomic_save

BASE = Path('/var/lib/cfsm-return-route')
OUTPUT = BASE / 'zhejiang.json'
LOG = Path('/var/log/cfsm-route-update.log')


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    with open('/run/lock/cfsm-route-update.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if os.environ.get('CFSM_NO_JITTER') != '1':
            time.sleep(random.randint(0, 300))
        stamp = datetime.now(timezone.utc).isoformat()
        try:
            old = json.loads(OUTPUT.read_text())
        except Exception:
            old = {}
        try:
            result = subprocess.run(['/usr/local/bin/cfsm-return-route.py', '浙江'],
                                    capture_output=True, text=True, timeout=150)
            data = json.loads(result.stdout) if result.returncode in (0, 2) else {}
            error = result.stderr[-1500:]
        except Exception as exc:
            data, error = {}, type(exc).__name__
        updated = 0
        for carrier in CARRIERS:
            value = data.get(carrier)
            valid = value in {'CN2', '9929', '10099', '4837', 'CMIN2', 'CMI', 'CMNET',
                              '普通国际', '国内电信', '国内联通', '国内移动'}
            candidate = {'route': value, 'confidence': data.get('confidence', {}).get(carrier, 'low'),
                         'reason': data.get('reason', {}).get(carrier, ''), 'route_type': value} if valid else None
            updated += merge_candidate(old, carrier, candidate, stamp)
        old.update(region='浙江', source='服务器每日 IPv4 回程探针', method='nexttrace-json-v3')
        old['last_attempt_at'] = stamp
        if 'target_ips' in data:
            old['target_ips'] = {**old.get('target_ips', {}), **data['target_ips']}
        # Compatibility fields describe accepted per-carrier records.
        old['confidence'] = {k: v.get('confidence', 'low') for k, v in old.get('carrier_meta', {}).items()}
        old['reason'] = {k: v.get('reason', '') for k, v in old.get('carrier_meta', {}).items()}
        atomic_save(OUTPUT, old)
        with LOG.open('a') as stream:
            stream.write(f'{stamp} FINISH updated={updated}/3 {error}\n')


if __name__ == '__main__':
    main()
