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
    const incomplete = /未完整|未知|未确认/.test(name);
    const quality = incomplete ? "standard" : classifyReturnRoute(name);
    const time = typeof route?.probed_at === "string" ? route.probed_at : "";
    const region = typeof route?.region === "string" ? route.region : "未记录";
    const source = typeof route?.source === "string" ? route.source : (manual ? "未记录" : "服务器探针");
    const title = incomplete ? `${name}；探测未完整，不能据此判断不通` : returnRouteTitle(name, quality, { carrierKey: key, probedAt: time || undefined });
    return <details className="route-cell">
      <summary title={title}><span className={clsx("return-route-summary-badge", `is-${quality}`)}>{name}</span></summary>
      <div className="route-cell-details">
        <div>{/^(TCPTest|NextTrace)/.test(source) ? "测量记录" : (manual ? "手动记录" : "探针检测")}</div>
        <div>地点：{region}</div>
        <div>来源：{source}</div>
        <div>时间：{time ? new Date(time).toLocaleString() : "未记录"}</div>
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
