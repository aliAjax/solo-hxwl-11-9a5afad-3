import type {
  AuditEntry,
  Conflict,
  ReviewAction,
  ReviewItem,
  ReviewState,
  ReviewStatus,
  Role,
} from "./types";
import { ReviewError } from "./types";
import { nextAuditId } from "./seed";

/**
 * 权限矩阵（复核台核心规则）
 * - 验光师：只能标记/重新开启冲突（不能关闭/流转/确认）
 * - 复查医生：关闭冲突 + 流转（待修正/需升级/确认），确认权仅医生
 * - 门店顾问：只读
 */
const ROLE_ACTIONS: Record<Role, ReadonlySet<ReviewAction["type"]>> = {
  optometrist: new Set(["mark_conflict", "reopen_conflict"]),
  doctor: new Set(["close_conflict", "to_pending_fix", "to_escalated", "confirm"]),
  advisor: new Set(),
};

export function can(role: Role, type: ReviewAction["type"]): boolean {
  return ROLE_ACTIONS[role].has(type);
}

/** 不改变状态、供 UI 决定按钮禁用与提示 */
export function denyReason(
  item: ReviewItem,
  type: ReviewAction["type"],
  role: Role
): string | null {
  if (!can(role, type)) {
    if (role === "optometrist") return "验光师只能标记冲突，流转与确认须由复查医生执行";
    if (role === "advisor") return "门店顾问为只读角色";
    return "当前角色无权执行该操作";
  }
  if (type === "confirm") {
    if (item.status === "confirmed") return "该处方已确认";
    if (item.conflicts.some((c) => c.status === "open")) {
      const n = item.conflicts.filter((c) => c.status === "open").length;
      return `尚有 ${n} 条冲突未关闭，不能确认`;
    }
  }
  if (type === "to_pending_fix" || type === "to_escalated") {
    if (item.status === "confirmed") return "已确认的事项不可再流转";
    if (item.status === (type === "to_pending_fix" ? "pending_fix" : "escalated")) {
      return "事项已处于该状态";
    }
  }
  if ((type === "mark_conflict" || type === "reopen_conflict") && item.status === "confirmed") {
    return "已确认的事项不能再标记冲突";
  }
  if (type === "close_conflict" && item.status === "confirmed") {
    return "已确认的事项不可操作";
  }
  return null;
}

const TARGET_STATUS: Partial<Record<ReviewAction["type"], ReviewStatus>> = {
  to_pending_fix: "pending_fix",
  to_escalated: "escalated",
  confirm: "confirmed",
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 冲突内容归一化：同指标 + 同说明（忽略首尾空白与重复空白）视为同一冲突 */
export function normContent(s: string | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ");
}

export function isSameContent(c: Conflict, metric: string, detail: string): boolean {
  return normContent(c.metric) === normContent(metric) && normContent(c.detail) === normContent(detail);
}

function findSameContent(item: ReviewItem, metric: string, detail: string, status: Conflict["status"]) {
  return item.conflicts.find((c) => c.status === status && isSameContent(c, metric, detail));
}

export type ApplyOutcome = "applied" | "conflict_deduped";

export interface ApplyResult {
  state: ReviewState;
  outcome: ApplyOutcome;
}

/**
 * 在状态上应用一个动作，返回新状态与结果。纯函数。
 * - 重复 actionId 抛 DUPLICATE_ACTION（含 outbox 重放）
 * - 同事项已存在同指标+同说明的【未关闭】冲突 → conflict_deduped：
 *     不新增冲突、不新增审计，无论间隔多久/刷新/断网重放/跨标签都只保留一条
 * - 同内容冲突仅处于【已关闭】状态时，mark_conflict 抛 CONFLICT_RESOLVED，
 *   必须走显式 reopen_conflict 才能重新登记
 * - 权限不足（FORBIDDEN）、冲突未关闭禁止确认（CONFLICT_OPEN）、终态/同态（ILLEGAL_TRANSITION）
 * 成功时写入审计（处理人 + 时间），并登记 actionId。
 */
export function applyAction(state: ReviewState, action: ReviewAction): ApplyResult {
  if (state.processedActions[action.actionId]) {
    throw new ReviewError("DUPLICATE_ACTION", "该处理已提交过，请勿重复操作");
  }

  const item = state.items.find((it) => it.id === action.itemId);
  if (!item) throw new ReviewError("NOT_FOUND", "复核事项不存在");

  // 1) 角色权限
  if (!can(action.actor.role, action.type)) {
    throw new ReviewError("FORBIDDEN", denyReason(item, action.type, action.actor.role) ?? "无权操作");
  }
  // 2) 业务门禁（已终态 / 冲突未关闭）
  if (item.status === "confirmed" && action.type !== "confirm") {
    throw new ReviewError("ILLEGAL_TRANSITION", "已确认的事项不可再流转或操作");
  }
  if (action.type === "confirm") {
    if (item.status === "confirmed") {
      throw new ReviewError("ILLEGAL_TRANSITION", "该处方已确认，请勿重复确认");
    }
    if (item.conflicts.some((c) => c.status === "open")) {
      throw new ReviewError("CONFLICT_OPEN", "冲突未关闭时不能确认");
    }
  }

  const next = clone(state);
  const target = next.items.find((it) => it.id === action.itemId)!;
  const actor = action.actor;

  const auditBase = (kind: AuditEntry["kind"], summary: string, conflictId?: string): AuditEntry => ({
    id: nextAuditId(),
    at: action.at,
    userId: actor.id,
    userName: actor.name,
    userRole: actor.role,
    kind,
    summary,
    conflictId,
  });

  if (action.type === "mark_conflict") {
    const metric = action.metric?.trim() || "手动标记冲突";
    const detail = action.detail?.trim() || "验光师在对照双眼屈光数据时标记的冲突";

    // 内容级幂等：同指标+同说明的未关闭冲突已存在 → 只保留一条
    if (findSameContent(target, metric, detail, "open")) {
      next.processedActions[action.actionId] = action.actionId;
      return { state: next, outcome: "conflict_deduped" };
    }
    // 同内容冲突已关闭：不允许静默新建，必须显式重新开启
    if (findSameContent(target, metric, detail, "resolved")) {
      throw new ReviewError(
        "CONFLICT_RESOLVED",
        "相同内容的冲突此前已关闭；如需再次登记，请对该冲突执行“重新开启”"
      );
    }

    const suffix = action.actionId.replace(/[^a-z0-9]/gi, "").slice(-8);
    const conflict: Conflict = {
      id: `cf-${action.itemId}-${suffix}`,
      metric,
      detail,
      status: "open",
      markedBy: actor.id,
      markedByName: actor.name,
      markedAt: action.at,
    };
    target.conflicts.push(conflict);
    target.audit.push(auditBase("mark_conflict", `标记冲突：${conflict.metric}`, conflict.id));
  } else if (action.type === "reopen_conflict") {
    const conflict = target.conflicts.find((c) => c.id === action.conflictId);
    if (!conflict) throw new ReviewError("NOT_FOUND", "冲突不存在");
    if (conflict.status === "open") {
      throw new ReviewError("ILLEGAL_TRANSITION", "该冲突尚未关闭，无需重新开启");
    }
    conflict.status = "open";
    conflict.markedBy = actor.id;
    conflict.markedByName = actor.name;
    conflict.markedAt = action.at;
    conflict.resolvedBy = undefined;
    conflict.resolvedByName = undefined;
    conflict.resolvedAt = undefined;
    const note = action.detail?.trim();
    target.audit.push(
      auditBase(
        "reopen_conflict",
        `重新开启冲突：${conflict.metric}${note ? `（${note}）` : ""}`,
        conflict.id
      )
    );
  } else if (action.type === "close_conflict") {
    const conflict = target.conflicts.find((c) => c.id === action.conflictId);
    if (!conflict) throw new ReviewError("NOT_FOUND", "冲突不存在");
    if (conflict.status === "resolved") {
      throw new ReviewError("ILLEGAL_TRANSITION", "该冲突已关闭");
    }
    conflict.status = "resolved";
    conflict.resolvedBy = actor.id;
    conflict.resolvedByName = actor.name;
    conflict.resolvedAt = action.at;
    target.audit.push(
      auditBase(
        "close_conflict",
        `关闭冲突：${conflict.metric}（${action.detail?.trim() || "复核无异议"}）`,
        conflict.id
      )
    );
  } else {
    const newStatus = TARGET_STATUS[action.type];
    if (!newStatus) throw new ReviewError("ILLEGAL_TRANSITION", "未知流转");
    if (target.status === newStatus) {
      throw new ReviewError("ILLEGAL_TRANSITION", "事项已处于该状态，无需重复流转");
    }
    if (action.type === "confirm" && target.conflicts.some((c) => c.status === "open")) {
      throw new ReviewError("CONFLICT_OPEN", "冲突未关闭时不能确认");
    }
    target.status = newStatus;
    const label: Record<string, string> = {
      pending_fix: "待修正",
      escalated: "需升级",
      confirmed: "已确认",
    };
    const note = action.detail?.trim();
    target.audit.push(
      auditBase(action.type, `流转：${label[newStatus]}${note ? `（${note}）` : ""}`)
    );
  }

  next.processedActions[action.actionId] = action.actionId;
  return { state: next, outcome: "applied" };
}

/** 服务端快照回放完成后，把本地待同步动作的审计标记为已同步（去掉 pendingSync） */
export function markAuditSynced(state: ReviewState): ReviewState {
  const next = clone(state);
  for (const item of next.items) {
    for (const entry of item.audit) delete entry.pendingSync;
  }
  return next;
}
