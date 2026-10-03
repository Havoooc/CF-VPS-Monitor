#!/usr/bin/env bash
set -euo pipefail

PROBE=/usr/local/bin/cf-probe.sh
CRON=/etc/cron.d/cfsm-route-update
BACKUP_DIR="/root/codex-backups/cfsm-daily-route-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
cp -a "$PROBE" "$BACKUP_DIR/cf-probe.sh"

python3 - "$PROBE" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
if 'RETURN_ROUTE_IPV6_JSON' not in text:
    marker = "    RETURN_ROUTE_JSON='{}'\n"
    block = marker + "    RETURN_ROUTE_IPV6_JSON='{}'\n    if [ -s /var/lib/cfsm-return-route/zhejiang-v6.json ] && python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding=\"utf-8\"))' /var/lib/cfsm-return-route/zhejiang-v6.json >/dev/null 2>&1; then\n        RETURN_ROUTE_IPV6_JSON=$(cat /var/lib/cfsm-return-route/zhejiang-v6.json)\n    fi\n"
    if text.count(marker) != 1:
        raise SystemExit('unexpected_cf_probe_return_route_block')
    text = text.replace(marker, block, 1)
    text = text.replace('"return_route":$RETURN_ROUTE_JSON}', '"return_route":$RETURN_ROUTE_JSON,"return_route_ipv6":$RETURN_ROUTE_IPV6_JSON}', 1)
if 'FORWARD_ROUTES_JSON' not in text:
    marker = "    RETURN_ROUTE_IPV6_JSON='{}'\n"
    block = marker + "    FORWARD_ROUTES_JSON='{}'\n    if [ -s /var/lib/cfsm-forward-route/routes.json ] && python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding=\"utf-8\"))' /var/lib/cfsm-forward-route/routes.json >/dev/null 2>&1; then\n        FORWARD_ROUTES_JSON=$(cat /var/lib/cfsm-forward-route/routes.json)\n    fi\n"
    if text.count(marker) != 1:
        raise SystemExit('unexpected_cf_probe_ipv6_block')
    text = text.replace(marker, block, 1)
    old = '"return_route":$RETURN_ROUTE_JSON,"return_route_ipv6":$RETURN_ROUTE_IPV6_JSON}'
    new = '"return_route":$RETURN_ROUTE_JSON,"return_route_ipv6":$RETURN_ROUTE_IPV6_JSON,"forward_routes":$FORWARD_ROUTES_JSON}'
    if text.count(old) != 1:
        raise SystemExit('unexpected_cf_probe_metrics_json')
    text = text.replace(old, new, 1)
path.write_text(text)
PY
bash -n "$PROBE"

if [ -f "$CRON" ]; then
  cp -a "$CRON" "$BACKUP_DIR/cfsm-route-update.cron"
  sed -i 's#15 \*/12 \* \* \*#15 3 * * *#' "$CRON"
  grep -q '^15 3 \* \* \* root /usr/local/bin/cfsm-route-update.sh$' "$CRON"
else
  TIMER=/etc/systemd/system/cfsm-route-update.timer
  test -f "$TIMER"
  cp -a "$TIMER" "$BACKUP_DIR/cfsm-route-update.timer"
  sed -i 's#OnCalendar=.*#OnCalendar=*-*-* 03:15:00#' "$TIMER"
  systemctl daemon-reload
  systemctl restart cfsm-route-update.timer
fi

if [ "${CFSM_ENABLE_IPV6:-0}" = 1 ]; then
  install -m 0755 /tmp/cfsm-route-update-v6.py /usr/local/bin/cfsm-route-update-v6.py
  test -x /usr/local/bin/cfsm-route-update-v6.py
  cat >/etc/cron.d/cfsm-route-update-v6 <<'EOF'
30 3 * * * root /usr/local/bin/cfsm-route-update-v6.py
EOF
  chmod 0644 /etc/cron.d/cfsm-route-update-v6
fi

if [ "${CFSM_ENABLE_FORWARD:-0}" = 1 ]; then
  test -n "${CFSM_SERVER_ID:-}"
  printf '%s\n' "$CFSM_SERVER_ID" >/etc/cfsm-forward-route-server-id
  chmod 0644 /etc/cfsm-forward-route-server-id
  install -m 0755 /tmp/cfsm-forward-route-update.py /usr/local/bin/cfsm-forward-route-update.py
  cat >/etc/cron.d/cfsm-forward-route-update <<'EOF'
5 3 * * * root /usr/local/bin/cfsm-forward-route-update.py
EOF
  chmod 0644 /etc/cron.d/cfsm-forward-route-update
fi

echo "Installed daily route schedule; backup=$BACKUP_DIR"
