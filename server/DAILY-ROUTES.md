# Daily route scans

Each overseas VPS scans its own IPv4/IPv6 forward paths through TCPTest Wenzhou nodes, six tasks per day. Server-local NextTrace supplies reverse paths. Alibaba keeps domestic carrier labels and its daily IPv4 reverse scan; it has no public IPv6 scan.

Forward and IPv6 reverse scans use persistent systemd timers at 03:05 and 03:30 UTC, with up to five minutes of jitter. IPv4 reverse scans use the same persistent UTC timers at 03:15. No throughput tests run. Observed ASN paths do not prove destination reachability.

Copy all three server scripts to /tmp, then run the installer with CFSM_ENABLE_IPV6=1 CFSM_ENABLE_FORWARD=1 CFSM_SERVER_ID=<monitor UUID>. Restart cf-probe.service after installation.

Results are saved atomically under /var/lib/cfsm-forward-route/routes.json and /var/lib/cfsm-return-route/zhejiang-v6.json. Existing authenticated cf-probe reports update forward_route:<id> and return_snapshot:<id>; IPv4 reverse paths use servers.return_route. Empty or failed probes preserve prior results. Heartbeats write settings only when normalized values change.

Logs: /var/log/cfsm-forward-route-update.log and /var/log/cfsm-route-update-v6.log. Task control tokens are discarded; file locks prevent overlapping runs.

All runtime scripts are tracked in this repository. Copy the server scripts and cfsm_route_core.py to /tmp before installation. Run the installer on Alibaba without IPv6/forward flags, and on overseas nodes with both flags and the monitor UUID.

Each carrier has independent carrier_meta: accepted probed_at, last_attempt_at, route_type, confidence and status. Failures retain the accepted value/time. Downgrades and incomplete forward-path changes need matching observations on two separate daily runs; retries on the same day never count twice. Retry at most once for insufficient probe results. Shared ASN classification distinguishes AS58453 (CMI), AS58807 (CMIN2), and domestic CMNET. CN2 evidence never implies GIA/GT. Raw observations may be incomplete even when a backbone segment is identifiable.

HTTP and WebSocket ingestion share the same validation, monotonic timestamp merge, persistence and change notification service. Errors are isolated from ordinary monitoring history. Card details use carrier timestamps; stale status is shown only inside the expanded details.
