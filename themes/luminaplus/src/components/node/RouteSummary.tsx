import { useState } from "react";
import { clsx } from "clsx";
import type { ReturnRoute, ForwardRoutes } from "@/types/cfsm";
import { classifyReturnRoute } from "@/utils/returnRoute";

const RETURN_ROUTE_CARRIERS = [
  { key: "telecom", label: "电信" },
  { key: "unicom", label: "联通" },
  { key: "mobile", label: "移动" },
] as const;

type CarrierKey = (typeof RETURN_ROUTE_CARRIERS)[number]["key"];

const BEST_ROUTE_PRIORITY: Record<CarrierKey, string[]> = {
  telecom: ["CN2GIA", "CN2GT", "CN2", "国内电信", "普通国际"],
  unicom: ["9929", "10099", "4837", "国内联通"],
  mobile: ["CMIN2", "CMI", "CMNET", "国内移动"],
};

function bestRouteLabel(route: ReturnRoute | undefined, key: CarrierKey) {
  const metaType = route?.carrier_meta?.[key]?.route_type?.trim();
  const raw = route?.[key]?.trim() || "";
  const value = (metaType || raw)
    .replace(/\s*[·,，]?\s*未完整/g, "")
    .replace(/\s*[·,，]?\s*Cox 未确认/g, "")
    .replace(/国际段未知/g, "—")
    .trim();
  if (!value || /^(未知|未检测|待检测|—|-)$/i.test(value)) return "";

  const normalized = value.toUpperCase().replace(/[\s_-]/g, "");
  const preferred = BEST_ROUTE_PRIORITY[key].find(label => normalized.includes(label.toUpperCase().replace(/[\s_-]/g, "")));
  if (preferred) return preferred;

  // Old forward records may lack route_type. Never put a raw hop-by-hop chain on the card.
  if (/→|AS\d{2,}/i.test(value)) return "已识别";
  return value;
}

export function RouteSummary({ returnRoute, forwardRoutes, returnRoutes, hasPublicIPv6 = true }: { returnRoute?: ReturnRoute; forwardRoutes?: ForwardRoutes; returnRoutes?: ForwardRoutes; hasPublicIPv6?: boolean }) {
  const [family, setFamily] = useState<"ipv4" | "ipv6">("ipv4");
  const forward = forwardRoutes?.[family];
  // Existing probe results use IPv4 unless explicitly marked otherwise.
  const reverse = returnRoutes?.[family] ?? ((returnRoute?.ip_version === "ipv6" ? family === "ipv6" : family === "ipv4") ? returnRoute : undefined);

  function routeCell(route: ReturnRoute | undefined, key: CarrierKey) {
    const displayName = bestRouteLabel(route, key);
    if (!displayName) return <span className="route-pending">待检测</span>;
    const quality = classifyReturnRoute(displayName);
    return <span className={clsx("return-route-summary-badge", `is-${quality}`)}>{displayName}</span>;
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
          <td>{routeCell(forward, key)}</td>
          <td>{routeCell(reverse, key)}</td>
        </tr>)}</tbody>
      </table>
    </section>
  );
}
