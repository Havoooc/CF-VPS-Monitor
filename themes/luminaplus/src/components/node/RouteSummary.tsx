import { useState } from "react";
import { clsx } from "clsx";
import type { ReturnRoute, ForwardRoutes } from "@/types/cfsm";
import { classifyReturnRoute, returnRouteTitle } from "@/utils/returnRoute";

const RETURN_ROUTE_CARRIERS = [
  { key: "telecom", label: "电信" },
  { key: "unicom", label: "联通" },
  { key: "mobile", label: "移动" },
] as const;

export function RouteSummary({ returnRoute, forwardRoutes, returnRoutes }: { returnRoute?: ReturnRoute; forwardRoutes?: ForwardRoutes; returnRoutes?: ForwardRoutes }) {
  const [family, setFamily] = useState<"ipv4" | "ipv6">("ipv4");
  const forward = forwardRoutes?.[family];
  // Existing probe results use IPv4 unless explicitly marked otherwise.
  const reverse = returnRoutes?.[family] ?? ((returnRoute?.ip_version === "ipv6" ? family === "ipv6" : family === "ipv4") ? returnRoute : undefined);

  function routeCell(route: ReturnRoute | undefined, key: "telecom" | "unicom" | "mobile", manual: boolean) {
    const name = route?.[key]?.trim();
    if (!name) return <span className="route-pending">待检测</span>;
    const displayName = name.replace(/\s*[·,，]?\s*未完整/g, "").replace(/\s*[·,，]?\s*Cox 未确认/g, "").replace(/国际段未知/g, "—").trim();
    const meta = route?.carrier_meta?.[key];
    const quality = classifyReturnRoute(meta?.route_type || displayName);
    const time = meta?.probed_at || (typeof route?.probed_at === "string" ? route.probed_at : "");
    const region = typeof route?.region === "string" ? route.region : "未记录";
    const source = typeof route?.source === "string" ? route.source : (manual ? "未记录" : "服务器探针");
    const title = returnRouteTitle(displayName, quality, { carrierKey: key, probedAt: time || undefined, confidence: meta?.confidence, reason: meta?.reason }).replace("回程线路", manual ? "去程线路" : "回程线路");
    return <details className="route-cell">
      <summary title={title}><span className={clsx("return-route-summary-badge", `is-${quality}`)}>{displayName}</span></summary>
      <div className="route-cell-details">
        <div>{/^(TCPTest|NextTrace)/.test(source) ? "测量记录" : (manual ? "手动记录" : "探针检测")}</div>
        <div>地点：{region}</div>
        <div>来源：{source}</div>
        <div>有效检测：{time ? new Date(time).toLocaleString() : "未记录"}</div>
        {meta?.last_attempt_at && <div>最近探测：{new Date(meta.last_attempt_at).toLocaleString()}</div>}
        {meta?.status && meta.status !== "ok" && <div>沿用上次有效记录</div>}
      </div>
    </details>;
  }
  return (
    <section className="return-route-summary" aria-label="三网去程与回程线路">
      <div className="route-summary-header">
        <span className="return-route-summary-heading">三网线路</span>
        <div className="route-family-switch" aria-label="线路地址族">
          {(["ipv4", "ipv6"] as const).map(value => <button type="button" key={value} aria-pressed={family === value} onClick={() => setFamily(value)}>{value.toUpperCase()}</button>)}
        </div>
      </div>
      <table className="route-comparison">
        <thead><tr><th scope="col">运营商</th><th scope="col">去程 →</th><th scope="col">← 回程</th></tr></thead>
        <tbody>{RETURN_ROUTE_CARRIERS.map(({key, label}) => <tr key={key}>
          <th scope="row">{label}</th>
          <td>{routeCell(forward, key, true)}</td>
          <td>{routeCell(reverse, key, false)}</td>
        </tr>)}</tbody>
      </table>
    </section>
  );
}
