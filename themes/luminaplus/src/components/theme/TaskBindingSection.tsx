import { Flag } from "@/components/ui/Flag";
import { memo } from "react";
import { Search } from "lucide-react";
import { clsx } from "clsx";
import type { NodeInfo, PingTask } from "@/types/cfsm";
import type { HomepagePingTaskBindings } from "@/utils/pingTasks";
import { summarizeNodes, pruneBindings, applyClientAssignment, applyAvailableClientAssignments } from "@/utils/themeManageBindings";

const EMPTY_ADMIN_CLIENTS: NodeInfo[] = [];

// 单个 Ping 任务的绑定卡片。memo:编辑无关设置的击键不再重渲任务列表;展开态的
// tasks×clients 复选网格只在绑定/搜索/展开变化时重算。
export const TaskBindingSection = memo(function TaskBindingSection({
  task,
  defaultTaskId,
  assigned,
  expanded,
  clientsById,
  visibleClients,
  assignedTaskByClientUuid,
  nodeSearch,
  onNodeSearch,
  onToggleExpand,
  onPatchBindings,
}: {
  task: PingTask;
  /** 站点当前的「默认线路」，用来给对应那张卡片打标。 */
  defaultTaskId: number;
  assigned: string[];
  expanded: boolean;
  clientsById: Map<string, NodeInfo>;
  visibleClients: NodeInfo[];
  assignedTaskByClientUuid: Map<string, string>;
  nodeSearch: string;
  onNodeSearch: (value: string) => void;
  onToggleExpand: (taskId: number) => void;
  onPatchBindings: (
    updater: (prev: HomepagePingTaskBindings) => HomepagePingTaskBindings,
  ) => void;
}) {
  const assignedSummary = summarizeNodes(assigned, clientsById);
  // 探测点是后端固定的四条线路，没绑定的节点会落到站长选的「默认线路」，这里标出来免得站长
  // 以为「0 个节点」就是没人用它。
  const isDefaultTask = task.id === defaultTaskId;
  // 过滤只有展开的任务需要;收起的卡片跳过,搜索输入不再对每个任务做 O(clients) 扫描。
  const selectableVisibleClients = expanded
    ? visibleClients.filter((client) => {
        const assignedTaskId = assignedTaskByClientUuid.get(client.uuid);
        return !assignedTaskId || assignedTaskId === String(task.id);
      })
    : EMPTY_ADMIN_CLIENTS;
  const allVisibleSelectableAssigned =
    selectableVisibleClients.length > 0 &&
    selectableVisibleClients.every((client) => assigned.includes(client.uuid));
  return (
    <section className="surface-inset px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
              {task.name || `任务 #${task.id}`}
            </h3>
            {isDefaultTask && (
              <span className="rounded-full border border-[var(--hairline)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
                默认线路
              </span>
            )}
          </div>
          <div className="mt-2 text-[12px] text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">
              {assigned.length > 0
                ? `${assigned.length} 台节点在首页显示这条线路的延迟`
                : "还没有节点选这条线路"}
            </span>
            {isDefaultTask && (
              <>
                <span className="mx-2 text-[var(--text-tertiary)]">·</span>
                <span>没单独指定线路的节点都走这条</span>
              </>
            )}
          </div>
          <p className="mt-2 text-[12px] text-[var(--text-tertiary)]" title={assignedSummary}>
            {assignedSummary}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {expanded && (
            <button
              type="button"
              disabled={selectableVisibleClients.length === 0 || allVisibleSelectableAssigned}
              onClick={() => {
                onPatchBindings((prev) =>
                  applyAvailableClientAssignments(
                    prev,
                    task.id,
                    selectableVisibleClients.map((client) => client.uuid),
                  ),
                );
              }}
              className="theme-manage-button is-compact"
            >
              {allVisibleSelectableAssigned ? "已全选可用" : "全选可用"}
            </button>
          )}
          {assigned.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onPatchBindings((prev) => {
                  const next = { ...prev };
                  delete next[String(task.id)];
                  return pruneBindings(next);
                });
              }}
              className="theme-manage-button is-compact is-danger"
            >
              清空节点
            </button>
          )}
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(task.id)}
            className="theme-manage-button is-compact"
          >
            {expanded ? "收起节点" : "编辑节点"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 border-t border-[var(--hairline)] pt-4">
          <label className="surface-inset flex items-center gap-2 px-3 py-2">
            <Search size={14} className="text-[var(--text-tertiary)]" />
            <input
              value={nodeSearch}
              onChange={(event) => onNodeSearch(event.target.value)}
              placeholder="搜索节点名称 / UUID / 分组 / 地区"
              aria-label="搜索节点"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </label>

          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {visibleClients.map((client) => {
              const checked = assigned.includes(client.uuid);
              const subtitle = [client.group, client.uuid].filter(Boolean).join(" · ");
              return (
                <label
                  key={client.uuid}
                  className={clsx(
                    "flex cursor-pointer items-start gap-3 rounded-[12px] border px-3 py-3 transition-colors",
                    checked
                      ? "border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--hover-bg)_72%,transparent)]"
                      : "border-[var(--hairline)] bg-transparent hover:bg-[var(--hover-bg)]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const nextChecked = event.target.checked;
                      onPatchBindings((prev) =>
                        applyClientAssignment(prev, task.id, client.uuid, nextChecked),
                      );
                    }}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent-500)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Flag region={client.region} size={14} />
                      <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {client.name}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                      {subtitle || client.region || "未设置分组"}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
});

