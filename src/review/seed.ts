import type {
  AuditEntry,
  Patient,
  ReviewItem,
  ReviewState,
  User,
} from "./types";

// 固定演示时间，保证刷新恢复后记录可读；与当前日期（2026-09-15）接近
export const NOW = "2026-09-15T09:30:00.000Z";

export const USERS: User[] = [
  { id: "u-doc-01", name: "林复查", role: "doctor", title: "复查医生" },
  { id: "u-opt-01", name: "王验光", role: "optometrist", title: "验光师" },
  { id: "u-opt-02", name: "陈验光", role: "optometrist", title: "验光师" },
  { id: "u-adv-01", name: "赵顾问", role: "advisor", title: "门店顾问" },
];

export const PATIENTS: Patient[] = [
  {
    id: "P-032",
    name: "Patient-032",
    category: "儿童",
    records: [
      {
        id: "rx-032-1",
        date: "2026-03-10",
        visitType: "初配",
        optometrist: "王验光",
        od: { sphere: -2.0, cylinder: -0.5, axis: 180, correctedVision: "1.0", pd: 58 },
        os: { sphere: -1.75, cylinder: -0.5, axis: 175, correctedVision: "1.0", pd: 58 },
        note: "儿童近视初配",
      },
      {
        id: "rx-032-2",
        date: "2026-06-12",
        visitType: "复查",
        optometrist: "王验光",
        od: { sphere: -2.25, cylinder: -0.5, axis: 180, correctedVision: "1.0", pd: 59 },
        os: { sphere: -2.0, cylinder: -0.5, axis: 178, correctedVision: "1.0", pd: 59 },
      },
      {
        id: "rx-032-3",
        date: "2026-09-11",
        visitType: "复查",
        optometrist: "陈验光",
        od: { sphere: -2.75, cylinder: -1.25, axis: 180, correctedVision: "1.0", pd: 60 },
        os: { sphere: -2.25, cylinder: -0.75, axis: 170, correctedVision: "1.0", pd: 60 },
        note: "右眼球镜半年加深 0.50D，散光加深 0.75D",
      },
    ],
  },
  {
    id: "P-144",
    name: "Patient-144",
    category: "成人",
    records: [
      {
        id: "rx-144-1",
        date: "2026-03-20",
        visitType: "初配",
        optometrist: "王验光",
        od: { sphere: -3.5, cylinder: -1.0, axis: 10, correctedVision: "1.0", pd: 64 },
        os: { sphere: -3.25, cylinder: -1.0, axis: 170, correctedVision: "1.0", pd: 64 },
      },
      {
        id: "rx-144-2",
        date: "2026-09-05",
        visitType: "复查",
        optometrist: "王验光",
        od: { sphere: -3.75, cylinder: -1.5, axis: 12, correctedVision: "1.0", pd: 64 },
        os: { sphere: -3.25, cylinder: -1.25, axis: 168, correctedVision: "1.0", pd: 64 },
        note: "柱镜变化 0.50D",
      },
    ],
  },
  {
    id: "P-081",
    name: "Patient-081",
    category: "渐进片",
    records: [
      {
        id: "rx-081-1",
        date: "2026-07-02",
        visitType: "初配",
        optometrist: "陈验光",
        od: { sphere: +1.25, cylinder: -0.5, axis: 90, correctedVision: "0.9", pd: 62 },
        os: { sphere: +1.25, cylinder: -0.5, axis: 88, correctedVision: "0.9", pd: 62 },
        note: "渐进片 ADD +1.50，瞳高待确认",
      },
      {
        id: "rx-081-2",
        date: "2026-09-08",
        visitType: "复查",
        optometrist: "王验光",
        od: { sphere: +1.75, cylinder: -0.5, axis: 95, correctedVision: "0.8", pd: 62 },
        os: { sphere: +1.5, cylinder: -0.75, axis: 80, correctedVision: "0.8", pd: 62 },
        note: "ADD +1.75，远用度数与瞳高数据两单不一致",
      },
    ],
  },
  {
    id: "P-207",
    name: "Patient-207",
    category: "角膜塑形镜",
    records: [
      {
        id: "rx-207-1",
        date: "2026-06-18",
        visitType: "初配",
        optometrist: "王验光",
        od: { sphere: -4.0, cylinder: -0.75, axis: 160, correctedVision: "1.0", pd: 61 },
        os: { sphere: -3.75, cylinder: -0.75, axis: 5, correctedVision: "1.0", pd: 61 },
      },
      {
        id: "rx-207-2",
        date: "2026-09-09",
        visitType: "复查",
        optometrist: "王验光",
        od: { sphere: -4.0, cylinder: -0.75, axis: 160, correctedVision: "1.0", pd: 61 },
        os: { sphere: -3.75, cylinder: -0.75, axis: 5, correctedVision: "1.0", pd: 61 },
        note: "屈光状态稳定",
      },
    ],
  },
];

let seq = 0;
export function nextAuditId(): string {
  seq += 1;
  return `au-${String(seq).padStart(3, "0")}`;
}

function createdEntry(itemId: string, summary: string, at: string): AuditEntry {
  return {
    id: `${itemId}-create`,
    at,
    userId: "system",
    userName: "系统",
    userRole: "advisor", // 系统记录不参与权限，仅展示
    kind: "created",
    summary,
  };
}

export function seedState(): ReviewState {
  const items: ReviewItem[] = [
    {
      id: "rv-032",
      patientId: "P-032",
      prescription: "2026-09-11 复查处方：OD -2.75/-1.25×180，OS -2.25/-0.75×170",
      status: "open",
      createdAt: "2026-09-12T01:10:00.000Z",
      conflicts: [
        {
          id: "cf-032-1",
          metric: "右眼球镜/散光差异",
          detail:
            "2026-06-12 OD -2.25/-0.50 → 2026-09-11 OD -2.75/-1.25：球镜变化 -0.50D、柱镜变化 -0.75D，超出单次复查容差 0.50D",
          status: "open",
          markedBy: "u-opt-02",
          markedByName: "陈验光",
          markedAt: "2026-09-12T01:20:00.000Z",
        },
      ],
      audit: [
        createdEntry("rv-032", "复核事项创建：Patient-032 2026-09-11 复查处方", "2026-09-12T01:10:00.000Z"),
        {
          id: "au-seed-032",
          at: "2026-09-12T01:20:00.000Z",
          userId: "u-opt-02",
          userName: "陈验光",
          userRole: "optometrist",
          kind: "mark_conflict",
          summary: "标记冲突：右眼球镜/散光差异",
          conflictId: "cf-032-1",
        },
      ],
    },
    {
      id: "rv-144",
      patientId: "P-144",
      prescription: "2026-09-05 复查处方：OD -3.75/-1.50×12，OS -3.25/-1.25×168",
      status: "open",
      createdAt: "2026-09-06T02:00:00.000Z",
      conflicts: [
        {
          id: "cf-144-1",
          metric: "右眼柱镜差异",
          detail:
            "2026-03-20 OD 柱镜 -1.00 → 2026-09-05 OD 柱镜 -1.50：变化 0.50D，轴位 10°→12°",
          status: "resolved",
          markedBy: "u-opt-01",
          markedByName: "王验光",
          markedAt: "2026-09-06T02:10:00.000Z",
          resolvedBy: "u-doc-01",
          resolvedByName: "林复查",
          resolvedAt: "2026-09-08T03:05:00.000Z",
        },
      ],
      audit: [
        createdEntry("rv-144", "复核事项创建：Patient-144 2026-09-05 复查处方", "2026-09-06T02:00:00.000Z"),
        {
          id: "au-seed-144a",
          at: "2026-09-06T02:10:00.000Z",
          userId: "u-opt-01",
          userName: "王验光",
          userRole: "optometrist",
          kind: "mark_conflict",
          summary: "标记冲突：右眼柱镜差异",
          conflictId: "cf-144-1",
        },
        {
          id: "au-seed-144b",
          at: "2026-09-08T03:05:00.000Z",
          userId: "u-doc-01",
          userName: "林复查",
          userRole: "doctor",
          kind: "close_conflict",
          summary: "关闭冲突：右眼柱镜差异（复查确认为真实散光变化）",
          conflictId: "cf-144-1",
        },
      ],
    },
    {
      id: "rv-081",
      patientId: "P-081",
      prescription: "2026-09-08 渐进片复查处方：OD +1.75/-0.50×95 ADD+1.75",
      status: "escalated",
      createdAt: "2026-09-09T02:00:00.000Z",
      conflicts: [
        {
          id: "cf-081-1",
          metric: "ADD 与瞳高数据不一致",
          detail:
            "初配单 ADD +1.50、瞳高待确认；复查单 ADD +1.75 且瞳高缺失，渐进片参数无法直接核对",
          status: "open",
          markedBy: "u-opt-01",
          markedByName: "王验光",
          markedAt: "2026-09-09T02:15:00.000Z",
        },
      ],
      audit: [
        createdEntry("rv-081", "复核事项创建：Patient-081 2026-09-08 渐进片复查处方", "2026-09-09T02:00:00.000Z"),
        {
          id: "au-seed-081a",
          at: "2026-09-09T02:15:00.000Z",
          userId: "u-opt-01",
          userName: "王验光",
          userRole: "optometrist",
          kind: "mark_conflict",
          summary: "标记冲突：ADD 与瞳高数据不一致",
          conflictId: "cf-081-1",
        },
        {
          id: "au-seed-081b",
          at: "2026-09-10T01:40:00.000Z",
          userId: "u-doc-01",
          userName: "林复查",
          userRole: "doctor",
          kind: "to_escalated",
          summary: "流转：需升级（参数矛盾，提交主任医师会诊）",
        },
      ],
    },
    {
      id: "rv-207",
      patientId: "P-207",
      prescription: "2026-09-09 OK镜复查处方：OD -4.00/-0.75×160，OS -3.75/-0.75×5",
      status: "open",
      createdAt: "2026-09-10T02:30:00.000Z",
      conflicts: [],
      audit: [
        createdEntry("rv-207", "复核事项创建：Patient-207 2026-09-09 复查处方", "2026-09-10T02:30:00.000Z"),
      ],
    },
  ];

  return { version: 2, rev: 0, items, processedActions: {} };
}
