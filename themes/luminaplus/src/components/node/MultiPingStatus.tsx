import { memo, useState } from "react";
import { clsx } from "clsx";
import { useMetricColorsVersion } from "@/hooks/useMetricColors";
import { usePreferences } from "@/hooks/usePreferences";
import type { HomepagePingDisplayLine, ReturnRoute } from "@/types/cfsm";
import { latencyHeatColor, lossHeatColor } from "@/utils/metricTone";
import {
  RETURN_ROUTE_QUALITY_LABEL,
  classifyReturnRoute,
  returnRouteTitle,
} from "@/utils/returnRoute";
import { HealthBucketTooltip } from "./HealthBucketTooltip";
import { LatencyBars } from "./LatencyBars";
import { PingLineSwitcher } from "./PingLineSwitcher";
import { QualityBars } from "./QualityBars";
import { formatHealthBucketTooltip } from "./pingBucketText";

type MultiPingStatusDensity = "large" | "compact";
type MultiPingMetric = "latency" | "loss";

const CompactMultiPingRow = memo(function CompactMultiPingRow({
  uuid,
  slot,
  line,
  redrawKey,
}: {
  uuid: string;
  slot: number;
  line: HomepagePingDisplayLine;
  redrawKey: string;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const isLoading = line.loadState === "pending";
  const isError = line.loadState === "error";
  const latencyColor = latencyHeatColor(line.lastValue);
  const lossColor = lossHeatColor(line.loss);
  const hoveredBucket = hoveredIndex == null ? null : (line.buckets[hoveredIndex] ?? null);
  const tooltip = hoveredBucket
    ? `${formatHealthBucketTooltip(hoveredBucket, "latency")} · 丢包 ${formatHealthBucketTooltip(hoveredBucket, "loss")}`
    : null;
  const latencyText = isLoading && line.lastValue == null
    ? "…"
    : isError && line.lastValue == null
      ? "!"
      : line.lastValue == null ? "—" : `${Math.round(line.lastValue)} ms`;
  const lossText = isLoading && line.loss == null
    ? "…"
    : isError && line.loss == null
      ? "!"
      : line.loss == null ? "—" : `${line.loss.toFixed(1)}%`;

  return (
    <div className="compact-ping-row" title={`${line.taskName} · 延迟 ${latencyText} · 丢包 ${lossText}${isError && (line.lastValue != null || line.loss != null) ? " · 刷新失败，显示上次数据" : ""}`}>
      <div className="compact-ping-summary">
        <span className="compact-ping-name-group">
          <PingLineSwitcher uuid={uuid} slot={slot} taskName={line.taskName} />
        </span>
        <span className="compact-ping-current-value" style={{ color: line.lastValue == null ? "var(--text-tertiary)" : latencyColor }}>
          <small>延迟</small>{latencyText}
        </span>
        <span className="compact-ping-current-value compact-ping-loss-value" style={{ color: line.loss == null ? "var(--text-tertiary)" : lossColor }}>
          <small>丢包</small>{lossText}
        </span>
      </div>
      <div className="compact-ping-trends">
        <span className="multi-ping-buckets">
          <LatencyBars buckets={line.buckets} redrawKey={redrawKey} height={6} onHoverIndex={setHoveredIndex} />
        </span>
        <span className="multi-ping-buckets">
          <QualityBars buckets={line.buckets} redrawKey={redrawKey} height={6} onHoverIndex={setHoveredIndex} />
        </span>
        <HealthBucketTooltip text={tooltip} index={hoveredIndex} count={line.buckets.length} />
      </div>
    </div>
  );
});

const MultiPingMetricRow = memo(function MultiPingMetricRow({
  uuid,
  slot,
  line,
  metric,
  density,
  redrawKey,
}: {
  uuid: string;
  slot: number;
  line: HomepagePingDisplayLine;
  metric: MultiPingMetric;
  density: MultiPingStatusDensity;
  redrawKey: string;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const latencyColor = latencyHeatColor(line.lastValue);
  const lossColor = lossHeatColor(line.loss);
  const isLoading = line.loadState === "pending";
  const isError = line.loadState === "error";
  const staleError = isError && (line.lastValue != null || line.loss != null);
  const latencyLabel =
    isLoading && line.lastValue == null
      ? "加载中"
      : isError && line.lastValue == null
        ? "加载失败"
        : line.lastValue == null
          ? "无样本"
          : `${Math.round(line.lastValue)}ms`;
  const lossLabel =
    isLoading && line.loss == null
      ? "加载中"
      : isError && line.loss == null
        ? "加载失败"
        : line.loss == null
          ? "—"
          : `${line.loss.toFixed(1)}%`;
  const hoveredBucket =
    hoveredIndex == null ? null : (line.buckets[hoveredIndex] ?? null);
  const tooltip = hoveredBucket
    ? formatHealthBucketTooltip(hoveredBucket, metric)
    : null;
  const chartHeight = density === "compact" ? 9 : 11;
  const value = metric === "latency" ? line.lastValue : line.loss;
  const valueColor = metric === "latency" ? latencyColor : lossColor;
  const unit = metric === "latency" ? "ms" : "%";
  const waiting = isLoading && value == null;
  const displayValue =
    waiting
      ? "..."
      : isError && value == null
        ? "!"
        : value == null
          ? "—"
          : metric === "latency"
            ? Math.round(value)
            : value.toFixed(1);
  return (
    <div
      className="multi-ping-metric-row"
      data-load-state={line.loadState ?? "ready"}
      title={`${line.taskName} · 延迟 ${latencyLabel} · 丢包 ${lossLabel}${
        staleError ? " · 刷新失败，显示上次数据" : ""
      }`}
    >
      <div
        className={clsx(
          "multi-ping-metric-head",
          metric === "loss" && "is-value-only",
        )}
      >
        {metric === "latency" && (
          <span className="multi-ping-name-group">
            <PingLineSwitcher uuid={uuid} slot={slot} taskName={line.taskName} />
          </span>
        )}
        <strong
          className="multi-ping-value tabular"
          style={{
            color: value == null ? "var(--text-tertiary)" : valueColor,
          }}
        >
          {displayValue}
          {value != null && <small>{unit}</small>}
        </strong>
      </div>
      <span className="multi-ping-buckets">
        {metric === "latency" ? (
          <LatencyBars
            buckets={line.buckets}
            redrawKey={redrawKey}
            height={chartHeight}
            onHoverIndex={setHoveredIndex}
          />
        ) : (
          <QualityBars
            buckets={line.buckets}
            redrawKey={redrawKey}
            height={chartHeight}
            onHoverIndex={setHoveredIndex}
          />
        )}
        <HealthBucketTooltip
          text={tooltip}
          index={hoveredIndex}
          count={line.buckets.length}
        />
      </span>
    </div>
  );
});

const MultiPingMetricColumn = memo(function MultiPingMetricColumn({
  uuid,
  lines,
  metric,
  density,
  redrawKey,
}: {
  uuid: string;
  lines: HomepagePingDisplayLine[];
  metric: MultiPingMetric;
  density: MultiPingStatusDensity;
  redrawKey: string;
}) {
  return (
    <div
      className="multi-ping-metric-column"
      aria-label={metric === "latency" ? "延迟" : "丢包"}
    >
      {lines.map((line, slot) => (
        // 按行号当 key，不按线路 id：访客在这一行换了线路（PingLineSwitcher）后还是同一行、
        // 同一颗按钮，焦点能回到它身上；按线路 id 会让整行卸载重建。
        <MultiPingMetricRow
          key={slot}
          uuid={uuid}
          slot={slot}
          line={line}
          metric={metric}
          density={density}
          redrawKey={redrawKey}
        />
      ))}
    </div>
  );
});

export const MultiPingStatus = memo(function MultiPingStatus({
  uuid,
  lines,
  density,
  className,
  returnRoute,
}: {
  uuid: string;
  lines: HomepagePingDisplayLine[];
  density: MultiPingStatusDensity;
  className?: string;
  returnRoute?: ReturnRoute;
}) {
  const { resolvedAppearance } = usePreferences();
  const colorsVersion = useMetricColorsVersion();
  const redrawKey = `${resolvedAppearance}:${colorsVersion}`;

  return (
    <div
      className={clsx("multi-ping-status", `is-${density}`, className)}
      role="group"
      aria-label="各线路延迟与丢包"
    >
      {density === "compact" ? (
        <div className="compact-ping-panel">
          <div className="compact-ping-panel-heading">
            <span>三网回程</span>
            <span className="compact-ping-legend"><i />延迟 <i />丢包趋势</span>
          </div>
          <div className="compact-ping-list">
            {lines.map((line, slot) => (
              <CompactMultiPingRow
                key={slot}
                uuid={uuid}
                slot={slot}
                line={line}
                redrawKey={redrawKey}
              />
            ))}
          </div>
          <ReturnRouteSummary returnRoute={returnRoute} />
        </div>
      ) : (
        <>
          <div className="multi-ping-columns">
            <MultiPingMetricColumn uuid={uuid} lines={lines} metric="latency" density={density} redrawKey={redrawKey} />
            <MultiPingMetricColumn uuid={uuid} lines={lines} metric="loss" density={density} redrawKey={redrawKey} />
          </div>
          <ReturnRouteSummary returnRoute={returnRoute} />
        </>
      )}
    </div>
  );
});

const RETURN_ROUTE_CARRIERS = [
  { key: "telecom", label: "电信" },
  { key: "unicom", label: "联通" },
  { key: "mobile", label: "移动" },
] as const;

function ReturnRouteSummary({ returnRoute }: { returnRoute?: ReturnRoute }) {
  if (!returnRoute) return null;

  const entries = RETURN_ROUTE_CARRIERS.flatMap(({ key, label }) => {
    const routeLabel = returnRoute[key]?.trim();
    if (!routeLabel) return [];
    const quality = classifyReturnRoute(routeLabel);
    const confidence = (returnRoute.confidence as Record<string, string> | undefined)?.[key];
    const reason = (returnRoute.reason as Record<string, string> | undefined)?.[key];
    const title = returnRouteTitle(routeLabel, quality, {
      carrierKey: key,
      confidence,
      reason,
      probedAt: typeof returnRoute.probed_at === "string" ? returnRoute.probed_at : undefined,
    });
    return [{ key, label, routeLabel, quality, confidence, title }];
  });

  if (entries.length === 0) return null;

  return (
    <section className="return-route-summary" aria-label="三网回程线路">
      <div className="return-route-summary-heading">回程线路</div>
      <div className="return-route-summary-grid">
        {entries.map(({ key, label, routeLabel, quality, confidence, title }) => (
          <div className="return-route-summary-item" key={key} title={title}>
            <span className="return-route-summary-carrier">{label}</span>
            <span
              className={clsx(
                "return-route-summary-badge",
                `is-${quality}`,
                confidence === "stale" && "is-stale",
              )}
            >
              <span className="return-route-summary-name">{routeLabel}</span>
              <span aria-hidden="true">·</span>
              <span>{RETURN_ROUTE_QUALITY_LABEL[quality]}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
