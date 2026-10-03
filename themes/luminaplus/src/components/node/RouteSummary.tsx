import { useState } from "react";
import { clsx } from "clsx";
import type { ReturnRoute, ForwardRoutes } from "@/types/cfsm";
import { classifyReturnRoute, returnRouteTitle } from "@/utils/returnRoute";

const RETURN_ROUTE_CARRIERS = [
  { key: "telecom", label: "电信" },
  { key: "unicom", label: "联通" },
  { key: "mobile", label: "移动" },
] as const;

export function RouteSummary({ returnRoute, forwardRoutes, returnRoutes, hasPublicIPv6 = true }: { returnRoute?: ReturnRoute; forwardRoutes?: ForwardRoutes; returnRoutes?: ForwardRoutes; hasPublicIPv6?: boolean }) {
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
    const region = meta?.region || (typeof route?.region === "string" ? route.region : "未记录");
    const source = meta?.source || (typeof route?.source === "string" ? route.source : (manual ? "未记录" : "服务器探针"));
    const reason = meta?.status === "held" ? "线路变化等待连续两天确认，沿用上次有效记录"
      : meta?.status === "failed" ? "本次未取得有效新证据，沿用上次记录"
      : meta?.reason === "observed backbone/transit ASN evidence" ? "已识别骨干和国际段 ASN；不据此确认终点可达"
      : meta?.reason === "destination reached; ASN evidence" ? "已到达探测终点，并取得 ASN 证据" : meta?.reason;
    const title = returnRouteTitle(displayName, quality, { carrierKey: key, probedAt: time || undefined, confidence: meta?.confidence, reason }).replace("回程线路", manual ? "去程线路" : "回程线路");
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
        <tbody>{family === "ipv6" && !hasPublicIPv6 ? (
          <tr><td colSpan={3}><span className="route-not-applicable">无公网 IPv6 · 去程与回程不适用</span></td></tr>
        ) : RETURN_ROUTE_CARRIERS.map(({key, label}) => <tr key={key}>
          <th scope="row">{label}</th>
          <td>{routeCell(forward, key, true)}</td>
          <td>{routeCell(reverse, key, false)}</td>
        </tr>)}</tbody>
      </table>
    </section>
  );
}
