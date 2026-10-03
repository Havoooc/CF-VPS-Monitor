"""Shared evidence, per-carrier freshness, and conservative route merging."""
import json
import os
import re
import tempfile
from pathlib import Path

CARRIERS = ('telecom', 'unicom', 'mobile')
QUALITY = {'CN2': 'excellent', 'CN2GIA': 'excellent', 'CN2GT': 'excellent',
           '9929': 'excellent', 'CMIN2': 'excellent', '10099': 'good', 'CMI': 'good'}


def route_type(carrier, asns, cn2_prefix=False):
    asns = {str(a).upper().removeprefix('AS') for a in asns}
    if carrier == 'telecom':
        if '4809' in asns or cn2_prefix:
            return 'CN2'
        if '4134' in asns:
            return '普通国际'
    if carrier == 'unicom':
        for asn in ('9929', '10099', '4837'):
            if asn in asns:
                return asn
    if carrier == 'mobile':
        if '58807' in asns:
            return 'CMIN2'
        if '58453' in asns:
            return 'CMI'
        if asns & {'9808', '56041'}:
            return 'CMNET'
    return None


def quality(value):
    text = str(value).upper()
    if text.startswith('国内') or any(t in text for t in ('CN2', '9929', 'CMIN2')):
        return 'excellent'
    if '10099' in text or re.search(r'(^|[^A-Z0-9])CMI([^A-Z0-9]|$)', text):
        return 'good'
    return QUALITY.get(value, 'standard')


def merge_candidate(record, carrier, candidate, stamp):
    """Preserve accepted route/time on failures or unconfirmed changes."""
    meta = record.setdefault('carrier_meta', {})
    previous = meta.get(carrier, {})
    current = dict(previous)
    current['last_attempt_at'] = stamp
    # Legacy family timestamp is only a fallback for the pre-migration record.
    if not current.get('probed_at') and record.get(carrier) and record.get('probed_at'):
        current['probed_at'] = record['probed_at']
    if not candidate or not candidate.get('route'):
        current.update(status='failed', reason=(candidate or {}).get('reason', 'no_valid_evidence'))
        current.pop('pending_value', None)
        current.pop('pending_count', None)
        current.pop('pending_day', None)
        meta[carrier] = current
        return False
    old = record.get(carrier)
    route = candidate['route']
    old_type = previous.get('route_type', old)
    new_type = candidate.get('route_type', route)
    ranks = {'standard': 0, 'good': 1, 'excellent': 2}
    downgrade = ranks[quality(new_type)] < ranks[quality(old_type)]
    uncertain_change = candidate.get('confidence') != 'high'
    if old and old != route and (downgrade or uncertain_change):
        same_value = previous.get('pending_value') == route
        day = stamp[:10]
        count = previous.get('pending_count', 0) if same_value and previous.get('pending_day') == day else (previous.get('pending_count', 0) + 1 if same_value else 1)
        if count < 2:
            current.update(status='held', reason='route_change_requires_two_daily_observations',
                           pending_value=route, pending_count=count, pending_day=day)
            meta[carrier] = current
            return False
    record[carrier] = route
    current.update(probed_at=stamp, status='ok', route_type=new_type, quality=quality(new_type),
                   confidence=candidate.get('confidence', 'medium'), reason=candidate.get('reason', ''))
    for field in ('region', 'source'):
        if candidate.get(field):
            current[field] = candidate[field]
    if isinstance(candidate.get('destination_reached'), bool):
        current['destination_reached'] = candidate['destination_reached']
    else:
        current.pop('destination_reached', None)
    current.pop('pending_value', None)
    current.pop('pending_count', None)
    current.pop('pending_day', None)
    meta[carrier] = current
    return True


def atomic_save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
