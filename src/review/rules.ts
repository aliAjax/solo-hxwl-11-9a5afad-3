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
 * - 验光师：只能标记冲突（不能关闭/流转/确认）
 * - 复查医生：关闭冲突 + 流转（待修正/需升级/确认），确认权仅医生
 * - 门店顾问：只读
 */
const ROLE_ACTIONS: Record<Role, ReadonlySet<ReviewAction["type"]>> = {
  optometrist: new Set(["mark_conflict"]),
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
  if (type === "mark_conflict" && item.status === "confirmed") {
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

/**
 * 在状态上应用一个动作，返回新状态。纯函数：
 * - 重复 actionId 只生效一次（DUPLICATE_ACTION）
 * - 权限不足（FORBIDDEN）
 * - 冲突未关闭禁止确认（CONFLICT_OPEN）
 * - 终态/非法流转（ILLEGAL_TRANSITION）
 * 成功时写入审计（处理人 + 时间），并登记 actionId。
 */
export function applyAction(state: ReviewState, action: ReviewAction): ReviewState {
  // 幂等：重复提交（含 outbox 重放）原样返回，不产生第二条审计
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
  if (action.type === "mark_conflict" && item.status === "confirmed") {
    throw new ReviewError("ILLEGAL_TRANSITION", "已确认的事项不能再标记冲突");
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
    const conflict: Conflict = {
      id: `cf-${action.itemId}-${target.conflicts.length + 1}-${action.actionId.slice(-4)}`,
      metric: action.metric?.trim() || "手动标记冲突",
      detail: action.detail?.trim() || "验光师在对照双眼屈光数据时标记的冲突",
      status: "open",
      markedBy: actor.id,
      markedByName: actor.name,
      markedAt: action.at,
    };
    target.conflicts.push(conflict);
    target.audit.push(
      auditBase("mark_conflict", `标记冲突：${conflict.metric}`, conflict.id)
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
      auditBase("close_conflict", `关闭冲突：${conflict.metric}（${action.detail?.trim() || "复核无异议"}）`, conflict.id)
    );
  } else {
    const newStatus = TARGET_STATUS[action.type];
    if (!newStatus) throw new ReviewError("ILLEGAL_TRANSITION", "未知流转");
    if (target.status === newStatus) {
      throw new ReviewError("ILLEGAL_TRANSITION", "事项已处于该状态，无需重复流转");
    }
    // confirm 的冲突门禁已由 denyReason 覆盖；这里再守一道
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
      auditBase(
        action.type,
        `流转：${label[newStatus]}${note ? `（${note}）` : ""}`
      )
    );
  }

  next.processedActions[action.actionId] = action.actionId;
  return next;
}

/** 服务端快照回放完成后，把本地待同步动作的审计标记为已同步（去掉 pendingSync） */
export function markAuditSynced(state: ReviewState): ReviewState {
  const next = clone(state);
  for (const item of next.items) {
    for (const entry of item.audit) delete entry.pendingSync;
  }
  return next;
}
