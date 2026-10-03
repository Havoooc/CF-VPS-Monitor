#!/usr/bin/env bash
set -euo pipefail

PROBE=/usr/local/bin/cf-probe.sh
CRON=/etc/cron.d/cfsm-route-update
BACKUP_DIR="/root/codex-backups/cfsm-daily-route-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
cp -a "$PROBE" "$BACKUP_DIR/cf-probe.sh"
for route_file in /var/lib/cfsm-return-route/zhejiang.json /var/lib/cfsm-return-route/zhejiang-v6.json /var/lib/cfsm-forward-route/routes.json; do
  if [ -f "$route_file" ]; then cp -a "$route_file" "$BACKUP_DIR/$(basename "$route_file")"; fi
done
for script in cfsm-route-update-v6.py cfsm-forward-route-update.py; do
  if [ -f "/usr/local/bin/$script" ]; then cp -a "/usr/local/bin/$script" "$BACKUP_DIR/"; fi
done

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

install_route_timer() {
  local task="$1" minute="$2"
  for suffix in service timer; do
    if [ -f "/etc/systemd/system/${task}.${suffix}" ]; then cp -a "/etc/systemd/system/${task}.${suffix}" "$BACKUP_DIR/"; fi
  done
  cat >"/etc/systemd/system/${task}.service" <<EOF
[Unit]
Description=Daily CFSM route scan
[Service]
Type=oneshot
ExecStart=/usr/local/bin/${task}.py
TimeoutStartSec=15min
EOF
  cat >"/etc/systemd/system/${task}.timer" <<EOF
[Unit]
Description=Daily CFSM route scan timer
[Timer]
OnCalendar=*-*-* 03:${minute}:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF
  rm -f "/etc/cron.d/${task}"
  systemctl daemon-reload
  systemctl enable --now "${task}.timer"
  systemctl restart "${task}.timer"
}

# Track and install the complete IPv4 implementation and shared merge policy.
for file in cfsm_route_core.py cfsm-return-route.py cfsm-return-route.sh cfsm-route-update.py cfsm-route-update.sh; do
  if [ -f "/usr/local/bin/$file" ]; then cp -a "/usr/local/bin/$file" "$BACKUP_DIR/"; fi
  install -m 0755 "/tmp/$file" "/usr/local/bin/$file"
done
if [ -f "$CRON" ]; then cp -a "$CRON" "$BACKUP_DIR/"; fi
install_route_timer cfsm-route-update 15

if [ "${CFSM_ENABLE_IPV6:-0}" = 1 ]; then
  install -m 0755 /tmp/cfsm-route-update-v6.py /usr/local/bin/cfsm-route-update-v6.py
  install_route_timer cfsm-route-update-v6 30
fi

if [ "${CFSM_ENABLE_FORWARD:-0}" = 1 ]; then
  test -n "${CFSM_SERVER_ID:-}"
  printf '%s\n' "$CFSM_SERVER_ID" >/etc/cfsm-forward-route-server-id
  chmod 0644 /etc/cfsm-forward-route-server-id
  install -m 0755 /tmp/cfsm-forward-route-update.py /usr/local/bin/cfsm-forward-route-update.py
  install_route_timer cfsm-forward-route-update 05
fi

echo "Installed daily route schedule; backup=$BACKUP_DIR"
