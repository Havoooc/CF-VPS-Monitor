import { memo } from "react";
import { Flag } from "@/components/ui/Flag";
import type { NodeInfo } from "@/types/cfsm";
import { calculateCostSummary, formatCnyMoney, formatSignedCny } from "@/utils/cost";
import type { ResolvedThemeSettings } from "@/utils/themeSettings";

type PremiumDetail = ReturnType<typeof calculateCostSummary>["details"][number];

// 溢价录入列表。memo:编辑其他设置的击键不重渲整表——引用变化只来自
// costPremiums 切片、搜索结果与汇率加载态。
export const PremiumList = memo(function PremiumList({
  clients,
  costPremiums,
  detailByUuid,
  rateLoading,
  acquiredAtMax,
  onPatchPaid,
  onPatchAcquiredAt,
}: {
  clients: NodeInfo[];
  costPremiums: ResolvedThemeSettings["costPremiums"];
  detailByUuid: Map<string, PremiumDetail>;
  rateLoading: boolean;
  acquiredAtMax: string;
  onPatchPaid: (uuid: string, rawValue: string) => void;
  onPatchAcquiredAt: (uuid: string, rawValue: string) => void;
}) {
  return (
    <div className="surface-inset max-h-[320px] overflow-y-auto">
      {clients.map((client) => {
        const entry = costPremiums[client.uuid];
        const detail = detailByUuid.get(client.uuid);
        const referenceLabel = rateLoading
          ? "计算中"
          : detail
            ? detail.counted
              ? formatCnyMoney(detail.remainingCny)
              : detail.note || "--"
            : "--";
        const canCompute = detail != null && (detail.counted || detail.note === "免费");
        return (
          <div
            key={client.uuid}
            className="flex items-center justify-between gap-3 border-b border-[var(--hairline)] px-3 py-2 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Flag region={client.region ?? ""} size={13} />
              <span
                className="truncate text-[13px] text-[var(--text-primary)]"
                title={client.name}
              >
                {client.name}
              </span>
              <span
                className="shrink-0 text-[11px] text-[var(--text-tertiary)]"
                title="该节点当前剩余价值（按账单周期折算，不含溢价）"
              >
                {referenceLabel}
              </span>
              {entry && (
                <span
                  className="shrink-0 text-[11px] font-medium"
                  style={{
                    color:
                      entry.amount > 0
                        ? "var(--status-error)"
                        : entry.amount < 0
                          ? "var(--status-success)"
                          : "var(--text-tertiary)",
                  }}
                  title={
                    entry.paidCny != null
                      ? "溢价 = 收购价 − 收购日剩余价值；该折算基准已经固化"
                      : "旧格式：直接记录的溢价，填写收购价后自动升级"
                  }
                >
                  溢价 {formatSignedCny(entry.amount)}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={entry?.paidCny ?? ""}
                onChange={(event) => {
                  // 键入 `-`/`e` 等非法中间态时 value 为空串,不能误当"留空即清除"删掉记录。
                  if (event.target.validity.badInput) return;
                  onPatchPaid(client.uuid, event.target.value);
                }}
                placeholder="收购价"
                disabled={!canCompute}
                aria-label={`${client.name} 的收购价`}
                title={
                  canCompute
                    ? "实际收购价（人民币），留空即清除记录"
                    : "该节点已忽略或汇率缺失，无法折算剩余价值"
                }
                className="surface-inset w-24 px-2 py-1 text-right text-[13px] outline-none disabled:opacity-45"
              />
              <input
                type="date"
                max={acquiredAtMax}
                value={entry?.acquiredAt ?? ""}
                onChange={(event) => onPatchAcquiredAt(client.uuid, event.target.value)}
                // 与收购价同门槛:汇率/基准未就绪时 patchPremiumAcquiredAt 无法回算,
                // 放开输入只会被静默丢弃(受控值弹回旧日期)。
                disabled={!entry || !canCompute}
                aria-label={`${client.name} 的收购日期`}
                title={
                  canCompute
                    ? "收购日期：修改后会按当前价格、周期、到期日和汇率回算该日剩余价值，重新计算并固化溢价"
                    : "该节点已忽略或汇率缺失，无法折算剩余价值"
                }
                className="surface-inset w-[8.75rem] px-2 py-1 text-[12px] outline-none disabled:opacity-45"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
});

