// 验光处方复核台 —— 领域模型

export type Role = "optometrist" | "doctor" | "advisor";

export interface User {
  id: string;
  name: string;
  role: Role;
  title: string;
}

export const ROLE_LABEL: Record<Role, string> = {
  optometrist: "验光师",
  doctor: "复查医生",
  advisor: "门店顾问",
};

/** 单眼屈光数据（DS 球镜 / DC 柱镜 / 轴位 / 矫正视力 / 瞳距） */
export interface EyeRx {
  sphere: number; // 球镜 D
  cylinder: number; // 柱镜 D（负数）
  axis: number; // 轴位 °
  correctedVision: string; // 矫正视力，如 1.0
  pd: number; // 瞳距 mm（双眼测量，两眼一致）
}

/** 一次验光/复查记录：双眼屈光数据 */
export interface RefractionRecord {
  id: string;
  date: string; // YYYY-MM-DD
  visitType: "初配" | "复查";
  optometrist: string;
  od: EyeRx; // 右眼
  os: EyeRx; // 左眼
  note?: string;
}

export interface Patient {
  id: string;
  name: string;
  category: "儿童" | "成人" | "渐进片" | "角膜塑形镜";
  records: RefractionRecord[]; // 按日期升序
}

/** 复核事项流转状态 */
export type ReviewStatus = "open" | "pending_fix" | "escalated" | "confirmed";

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  open: "待复核",
  pending_fix: "待修正",
  escalated: "需升级",
  confirmed: "已确认",
};

/** 冲突状态 */
export type ConflictStatus = "open" | "resolved";

export interface Conflict {
  id: string;
  metric: string; // 冲突指标
  detail: string; // 描述（哪些日期/眼别/数值差异）
  status: ConflictStatus;
  markedBy: string; // 用户 id
  markedByName: string;
  markedAt: string; // ISO 时间
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: string;
}

/** 处理记录（审计）：每次决定保留处理人与时间 */
export interface AuditEntry {
  id: string;
  at: string; // ISO 时间
  userId: string;
  userName: string;
  userRole: Role;
  kind: ActionType | "created";
  summary: string;
  conflictId?: string;
  /** 断网期间在本地产生、尚未被服务端接受 */
  pendingSync?: boolean;
}

export type ActionType =
  | "mark_conflict"
  | "close_conflict"
  | "to_pending_fix"
  | "to_escalated"
  | "confirm";

export interface ReviewItem {
  id: string;
  patientId: string;
  prescription: string; // 复核所针对的处方摘要
  status: ReviewStatus;
  conflicts: Conflict[];
  audit: AuditEntry[];
  createdAt: string;
}

export interface ReviewState {
  version: 1;
  items: ReviewItem[];
  /** 服务端已处理动作幂等键：actionId -> 对应审计 id */
  processedActions: Record<string, string>;
}

/** 一次流转/冲突操作请求 */
export interface ReviewAction {
  actionId: string; // 客户端生成，用于重复提交只生效一次
  type: ActionType;
  itemId: string;
  actor: User;
  at: string; // ISO 时间，离线时记录的是实际操作时刻
  conflictId?: string;
  metric?: string;
  detail?: string;
}

export type ErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT_OPEN"
  | "ILLEGAL_TRANSITION"
  | "DUPLICATE_ACTION"
  | "NETWORK_OFFLINE";

export class ReviewError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
