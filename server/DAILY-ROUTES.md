# Daily route scans

Each overseas VPS scans its own IPv4/IPv6 forward paths through TCPTest Wenzhou nodes, six tasks per day. Server-local NextTrace supplies reverse paths. Alibaba keeps domestic carrier labels and its daily IPv4 reverse scan; it has no public IPv6 scan.

Forward and IPv6 reverse scans use persistent systemd timers at 03:05 and 03:30 UTC, with up to five minutes of jitter. IPv4 reverse scans retain the existing daily scheduler. No throughput tests run. Observed ASN paths do not prove destination reachability.

Copy all three server scripts to /tmp, then run the installer with CFSM_ENABLE_IPV6=1 CFSM_ENABLE_FORWARD=1 CFSM_SERVER_ID=<monitor UUID>. Restart cf-probe.service after installation.

Results are saved atomically under /var/lib/cfsm-forward-route/routes.json and /var/lib/cfsm-return-route/zhejiang-v6.json. Existing authenticated cf-probe reports update forward_route:<id> and return_snapshot:<id>; IPv4 reverse paths use servers.return_route. Empty or failed probes preserve prior results. Heartbeats write settings only when normalized values change.

Logs: /var/log/cfsm-forward-route-update.log and /var/log/cfsm-route-update-v6.log. Task control tokens are discarded; file locks prevent overlapping runs.
