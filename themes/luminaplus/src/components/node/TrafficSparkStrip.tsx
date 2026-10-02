import { useCallback } from "react";
import { CanvasStrip, safeCanvasColor } from "./CanvasStrip";
import type { TrafficTrendSample } from "@/types/cfsm";

// 趋势 sparkline:样本值按近期最大值归一化成一条平滑折线,末端圆点标记「现在」。
// 数据与旧圆点条同为 trafficTrend 样本,只是换了一种密度更高的读法。
// 全部样本为零时画一条低透明度基线(仍提示「通道在、只是空闲」),空样本则不画。
// 大卡(流量区整行)与紧凑卡(实时速率 tile 内每方向一条)共用同一实现,只改高度。
export function TrafficSparkStrip({
  samples,
  color,
  redrawKey,
  height = 18,
  className = "traffic-spark-strip",
}: {
  samples: TrafficTrendSample[];
  color: string;
  redrawKey: string;
  height?: number;
  className?: string;
}) {
  // samples(缓存的 store 快照)与 color 不变则 draw 引用稳定,
  // canvas 只在趋势真的变动时才重绘。
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, canvasHeight: number) => {
      if (samples.length === 0) return;
      const baseColor = safeCanvasColor(color);
      const inactiveColor = safeCanvasColor("var(--progress-bg)");
      const maxValue = samples.reduce((max, sample) => Math.max(max, sample.value), 0);
      const hasTraffic = maxValue > 0;

      // 上下各留一点边距,线宽加末端圆点都不会被裁掉;高度很小时按比例收敛。
      const padY = Math.min(2.5, canvasHeight / 4);
      const usable = canvasHeight - padY * 2;
      const slotWidth = samples.length > 1 ? width / (samples.length - 1) : 0;
      const points = samples.map((sample, index) => ({
        x: samples.length > 1 ? index * slotWidth : width / 2,
        y: canvasHeight - padY - (hasTraffic ? sample.value / maxValue : 0) * usable,
      }));

      ctx.strokeStyle = hasTraffic ? baseColor : inactiveColor;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.globalAlpha = hasTraffic ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      // 中点二次曲线平滑:每段以相邻两点的中点为终点、当前点为控制点,折线立刻
      // 变成圆润的 sparkline,且不需要引入任何样条库。
      for (let i = 1; i < points.length - 1; i += 1) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
      }
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.fillStyle = hasTraffic ? baseColor : inactiveColor;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2, 0, Math.PI * 2);
      ctx.fill();
    },
    [samples, color],
  );

  return (
    <CanvasStrip
      className={className}
      height={height}
      redrawKey={redrawKey}
      draw={draw}
    />
  );
}
