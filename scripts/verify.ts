/* 验证脚本：权限 / 越级流转 / 冲突门禁 / 重复处理幂等 / 断网+刷新恢复 */
import { applyAction } from "../src/review/rules";
import { seedState, USERS } from "../src/review/seed";
import { MockServer } from "../src/review/server";
import { ReviewStore } from "../src/review/store";
import {
  CLIENT_KEY,
  LOCK_KEY,
  SERVER_KEY,
  loadJSON,
  loadLocalData,
  loadState,
  localKey,
  memoryKV,
  saveJSON,
  saveLocalData,
  saveState,
  sharedMemoryKV,
} from "../src/review/storage";
import type { ActionType, ReviewAction, ReviewError, ReviewState } from "../src/review/types";

const doctor = USERS[0]; // 林复查
const opt = USERS[1]; // 王验光
const opt2 = USERS[2]; // 陈验光
const advisor = USERS[3]; // 赵顾问

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

async function expectStore(
  name: string,
  fn: () => Promise<{ ok: boolean; code?: string }>,
  code: string
): Promise<void> {
  const r = await fn();
  check(name, !r.ok && r.code === code, r);
}

function expectEngineCode(state: ReviewState, action: ReviewAction, code: string): boolean {
  try {
    applyAction(state, action);
    return false;
  } catch (e) {
    return (e as ReviewError).code === code;
  }
}

function act(
  type: ActionType,
  actor: typeof doctor,
  itemId: string,
  extra: Partial<ReviewAction> = {}
): ReviewAction {
  return {
    actionId: extra.actionId ?? `aid-${Math.random().toString(36).slice(2, 9)}`,
    type,
    itemId,
    actor,
    at: new Date().toISOString(),
    ...extra,
  };
}

function setup() {
  const kv = memoryKV();
  const server = new MockServer(kv, { latencyMs: 0 });
  const store = new ReviewStore(server, kv);
  const itemOf = (id: string) =>
    store.getView().state.items.find((i) => i.id === id)!;
  return { kv, server, store, itemOf };
}

async function main(): Promise<void> {
  // ───────────────────────── A. 权限矩阵 ─────────────────────────
  console.log("\n[A] 权限：验光师只能标记冲突；仅医生能关闭/流转/确认；顾问只读");
  {
    const { store, itemOf } = setup();
    const before = itemOf("rv-207").audit.length;

    await expectStore("顾问标记冲突 → FORBIDDEN", () =>
      store.dispatch(act("mark_conflict", advisor, "rv-207"), "t1"), "FORBIDDEN");
    await expectStore("顾问转待修正 → FORBIDDEN", () =>
      store.dispatch(act("to_pending_fix", advisor, "rv-207"), "t2"), "FORBIDDEN");
    await expectStore("验光师关闭冲突 → FORBIDDEN", () =>
      store.dispatch(act("close_conflict", opt, "rv-032", { conflictId: "cf-032-1" }), "t3"),
      "FORBIDDEN");
    await expectStore("验光师转待修正 → FORBIDDEN", () =>
      store.dispatch(act("to_pending_fix", opt, "rv-207"), "t4"), "FORBIDDEN");
    await expectStore("验光师转需升级 → FORBIDDEN", () =>
      store.dispatch(act("to_escalated", opt, "rv-207"), "t5"), "FORBIDDEN");
    await expectStore("验光师确认 → FORBIDDEN（即使无冲突也不行）", () =>
      store.dispatch(act("confirm", opt, "rv-207"), "t6"), "FORBIDDEN");
    await expectStore("医生标记冲突 → FORBIDDEN（标记权仅验光师）", () =>
      store.dispatch(act("mark_conflict", doctor, "rv-207", { metric: "x" }), "t7"),
      "FORBIDDEN");

    check("被拒操作均未产生审计/状态变化", itemOf("rv-207").audit.length === before);

    const r = await store.dispatch(
      act("mark_conflict", opt, "rv-207", { metric: "右眼轴位差异", detail: "测试" }),
      "t8"
    );
    check("验光师标记冲突成功", r.ok === true);
    const item = itemOf("rv-207");
    check("事项状态仍为待复核（标记冲突不改变流转状态）", item.status === "open");
    check("冲突登记为未关闭并记录标记人/时间",
      item.conflicts[0].status === "open" &&
      item.conflicts[0].markedByName === "王验光" &&
      item.conflicts[0].markedAt.length > 0);
  }

  // ───────────────────────── B. 冲突门禁 + 越级/非法流转 ─────────────────────────
  console.log("\n[B] 冲突未关闭不能确认；终态与同态流转被拒");
  {
    const { store, itemOf } = setup();
    await expectStore("医生确认 rv-032（有未关闭冲突）→ CONFLICT_OPEN", () =>
      store.dispatch(act("confirm", doctor, "rv-032"), "b1"), "CONFLICT_OPEN");
    check("被拒后状态仍为待复核", itemOf("rv-032").status === "open");

    await expectStore("已升级事项重复转需升级 → ILLEGAL_TRANSITION", () =>
      store.dispatch(act("to_escalated", doctor, "rv-081"), "b2"), "ILLEGAL_TRANSITION");

    // 升级态可转待修正（非确认动作不受冲突门禁）
    const rFix = await store.dispatch(act("to_pending_fix", doctor, "rv-081"), "b3");
    check("升级态可转待修正", rFix.ok && itemOf("rv-081").status === "pending_fix");
    await expectStore("待修正态有未关闭冲突仍不能确认 → CONFLICT_OPEN", () =>
      store.dispatch(act("confirm", doctor, "rv-081"), "b4"), "CONFLICT_OPEN");

    // 关闭冲突 → 确认成功
    const rClose = await store.dispatch(
      act("close_conflict", doctor, "rv-081", { conflictId: "cf-081-1", detail: "参数补齐" }),
      "b5"
    );
    check("医生关闭冲突成功", rClose.ok && itemOf("rv-081").conflicts[0].status === "resolved");
    const at0 = "2026-09-15T10:00:00.000Z";
    const rConf = await store.dispatch(act("confirm", doctor, "rv-081", { at: at0 }), "b6");
    check("冲突关闭后确认成功", rConf.ok && itemOf("rv-081").status === "confirmed");

    await expectStore("确认后再转待修正 → ILLEGAL_TRANSITION", () =>
      store.dispatch(act("to_pending_fix", doctor, "rv-081"), "b7"), "ILLEGAL_TRANSITION");
    await expectStore("确认后验光师再标冲突 → ILLEGAL_TRANSITION", () =>
      store.dispatch(act("mark_conflict", opt, "rv-081", { metric: "x" }), "b8"),
      "ILLEGAL_TRANSITION");
    await expectStore("重复确认 → ILLEGAL_TRANSITION", () =>
      store.dispatch(act("confirm", doctor, "rv-081"), "b9"), "ILLEGAL_TRANSITION");

    const last = itemOf("rv-081").audit[itemOf("rv-081").audit.length - 1];
    // 注意：b9 被拒，最后一条仍是成功的确认记录
    const confirmEntry = [...itemOf("rv-081").audit].reverse().find((a) => a.kind === "confirm")!;
    check("确认记录保留处理人与时间",
      confirmEntry.userName === "林复查" && confirmEntry.at === at0, confirmEntry);
    check("拒绝操作不写入审计", last.kind === "confirm");
  }

  // 纯引擎层：终态关闭冲突
  {
    const s = seedState();
    const confirmed = applyAction(
      s, act("confirm", doctor, "rv-144") // rv-144 冲突已关闭
    ).state;
    check("引擎：冲突全关的事项可确认",
      confirmed.items.find((i) => i.id === "rv-144")!.status === "confirmed");
    check("引擎：确认后关闭冲突被拒 ILLEGAL_TRANSITION",
      expectEngineCode(confirmed,
        act("close_conflict", doctor, "rv-144", { conflictId: "cf-144-1" }),
        "ILLEGAL_TRANSITION"));
  }

  // ───────────────────────── C. 重复处理只生效一次 ─────────────────────────
  console.log("\n[C] 幂等：双击 / 同 actionId 重放 / 服务端去重");
  {
    // C1 引擎层 actionId 去重
    const s0 = seedState();
    const a = act("to_escalated", doctor, "rv-207", { actionId: "dup-1" });
    const s1 = applyAction(s0, a).state;
    check("引擎：相同 actionId 再放 → DUPLICATE_ACTION",
      expectEngineCode(s1, a, "DUPLICATE_ACTION"));
    check("引擎：去重后审计不增加",
      s1.items.find((i) => i.id === "rv-207")!.audit.length ===
      seedState().items.find((i) => i.id === "rv-207")!.audit.length + 1);
    check("引擎：processedActions 只登记一次",
      Object.keys(s1.processedActions).length === 1 && s1.processedActions["dup-1"] === "dup-1");

    // C2 服务端去重
    const { server, store } = setup();
    const a2 = act("to_pending_fix", doctor, "rv-207", { actionId: "dup-2" });
    const r1 = await server.dispatch(a2);
    const r2 = await server.dispatch(a2);
    check("服务端：首次受理、重复 actionId 去重", r1.deduped === false && r2.deduped === true);
    check("服务端：状态只流转一次",
      server.getState().items.find((i) => i.id === "rv-207")!.status === "pending_fix");

    // C3 客户端双击（并发同 opKey）
    const p1 = store.dispatch(act("to_escalated", doctor, "rv-207"), "double");
    const p2 = store.dispatch(act("to_escalated", doctor, "rv-207"), "double");
    const [x1, x2] = await Promise.all([p1, p2]);
    const audits = store.getView().state.items.find((i) => i.id === "rv-207")!.audit;
    check("客户端：并发重复提交仅一次受理", x1.ok === true && x2.ok === false && x2.deduped === true,
      { x1, x2 });
    check("客户端：审计只新增 2 条（待修正+需升级），无重复",
      audits.filter((a3) => a3.kind === "to_escalated").length === 1 &&
      audits.filter((a3) => a3.kind === "to_pending_fix").length === 1);

    // C4 服务端独立鉴权（绕过客户端不可越权）
    let blocked = false;
    try {
      await server.dispatch(act("confirm", opt, "rv-144"));
    } catch (e) {
      blocked = (e as ReviewError).code === "FORBIDDEN";
    }
    check("服务端：验光师确认被独立拒绝（不能靠绕过客户端越权）", blocked);
  }

  // ───────────────────────── D. 断网 + 刷新恢复 ─────────────────────────
  console.log("\n[D] 断网暂存 → 刷新 → 恢复网络：状态/记录恢复，重放只生效一次");
  {
    const kv = memoryKV();
    const server1 = new MockServer(kv, { latencyMs: 0 });
    const store1 = new ReviewStore(server1, kv);

    await store1.setOnline(false);
    check("断网标记", store1.getView().online === false);

    // 离线期间：验光师标冲突、医生关闭、医生确认
    await store1.dispatch(
      act("mark_conflict", opt, "rv-144", {
        metric: "离线补充冲突",
        detail: "断网时补充登记",
        at: "2026-09-15T08:00:00.000Z",
      }),
      "d-mark"
    );
    await store1.dispatch(
      act("close_conflict", doctor, "rv-032", {
        conflictId: "cf-032-1",
        detail: "离线核对无误",
        at: "2026-09-15T08:05:00.000Z",
      }),
      "d-close"
    );
    // rv-032 本地乐观关闭后，离线确认也应被本地规则接受并进队列
    const rConfOffline = await store1.dispatch(
      act("confirm", doctor, "rv-032", { at: "2026-09-15T08:06:00.000Z" }),
      "d-confirm"
    );
    check("离线决定本地即时生效并排队", rConfOffline.ok && store1.getView().outboxCount === 3);
    check("离线界面已显示确认态",
      store1.getView().state.items.find((i) => i.id === "rv-032")!.status === "confirmed");
    check("离线审计标记待同步",
      store1.getView().state.items
        .find((i) => i.id === "rv-032")!.audit
        .filter((a) => a.pendingSync).length >= 2);

    // 操作时刻被保留（而非重放时刻）
    const offlineConfirm = store1.getView().state.items
      .find((i) => i.id === "rv-032")!.audit
      .find((a) => a.kind === "confirm")!;
    check("离线操作保留实际处理时间", offlineConfirm.at === "2026-09-15T08:06:00.000Z");

    // 模拟刷新：服务端仍未收到动作（SERVER_KEY 是断网前的状态）
    const serverBeforeReload = loadState(kv, SERVER_KEY)!;
    check("断网期间服务端库未被污染",
      serverBeforeReload.items.find((i) => i.id === "rv-032")!.status === "open" &&
      Object.keys(serverBeforeReload.processedActions).length === 0);

    const local = loadLocalData(kv, store1.clientId)!;
    check("本标签数据已持久化 outbox（3 条）",
      Array.isArray(local.outbox) && local.outbox.length === 3);

    // 刷新：全新 server/store 实例（同一标签复用 clientId，此时网络仍未恢复）
    const server2 = new MockServer(kv, { latencyMs: 0 });
    const store2 = new ReviewStore(server2, kv, { clientId: store1.clientId });
    await store2.setOnline(false);
    check("刷新后即时恢复：确认态可见",
      store2.getView().state.items.find((i) => i.id === "rv-032")!.status === "confirmed");
    check("刷新后即时恢复：outbox 3 条仍在", store2.getView().outboxCount === 3);
    check("刷新后处理记录完整（处理人/时间/待同步标记）",
      store2.getView().state.items.find((i) => i.id === "rv-032")!.audit.length ===
      store1.getView().state.items.find((i) => i.id === "rv-032")!.audit.length);

    // 恢复网络：重放
    await store2.setOnline(true);
    check("重放后 outbox 清空", store2.getView().outboxCount === 0);
    const finalItem = store2.getView().state.items.find((i) => i.id === "rv-032")!;
    check("重放后最终状态：已确认", finalItem.status === "confirmed");
    check("重放后无待同步标记", finalItem.audit.every((a) => !a.pendingSync));
    check("审计无重复：rv-032 共 4 条（2 种子 + 关闭 + 确认）", finalItem.audit.length === 4,
      finalItem.audit.map((a) => a.kind));

    const rv144 = store2.getView().state.items.find((i) => i.id === "rv-144")!;
    check("离线标记的冲突也已同步并可在服务端状态中看到",
      rv144.conflicts.some((c) => c.metric === "离线补充冲突" && c.status === "open"));

    // 服务端持久化：再起一个 server 实例（模拟后端重启/他人刷新）
    const server3 = new MockServer(kv, { latencyMs: 0 });
    const persisted = server3.getState();
    check("服务端重启后状态持久化：rv-032 已确认",
      persisted.items.find((i) => i.id === "rv-032")!.status === "confirmed");
    check("服务端记录 3 个 actionId",
      Object.keys(persisted.processedActions).length === 3);

    // 重放安全：用已处理的 actionId 构造不同动作再打一次服务端 → 先查幂等表，直接去重
    const replayAction: ReviewAction = {
      actionId: Object.keys(server3.getState().processedActions)[0],
      type: "mark_conflict",
      itemId: "rv-144",
      actor: opt,
      at: "2026-09-15T08:00:00.000Z",
      metric: "离线补充冲突",
      detail: "断网时补充登记",
    };
    const again = await server3.dispatch(replayAction);
    check("旧 actionId 重放被服务端去重", again.deduped === true);
    check("去重后审计无增长",
      server3.getState().items.find((i) => i.id === "rv-144")!.audit.length ===
      persisted.items.find((i) => i.id === "rv-144")!.audit.length);
  }

  // ───────────────────────── E. 在线刷新恢复（无断网） ─────────────────────────
  console.log("\n[E] 在线操作后刷新：状态与处理记录从持久化恢复");
  {
    const kv = memoryKV();
    const server = new MockServer(kv, { latencyMs: 0 });
    const s1 = new ReviewStore(server, kv);
    await s1.dispatch(act("to_pending_fix", doctor, "rv-207"), "e1");
    const after = new ReviewStore(new MockServer(kv, { latencyMs: 0 }), kv);
    check("新实例恢复 rv-207 待修正态",
      after.getView().state.items.find((i) => i.id === "rv-207")!.status === "pending_fix");
    check("新实例恢复审计（处理人林复查）",
      after.getView().state.items.find((i) => i.id === "rv-207")!.audit
        .some((a) => a.kind === "to_pending_fix" && a.userName === "林复查"));
  }

  // ───────── F. 冲突内容级幂等：同指标同说明只留一条 ─────────
  console.log("\n[F] 同指标同说明冲突：跨 actionId/刷新/断网重放只保留一条未关闭冲突+一条审计");
  {
    const { store, itemOf } = setup();
    const m = "右眼球镜差异";
    const d = "2026-06-12 -2.25 → 2026-09-11 -2.75，变化 -0.50D";

    const r1 = await store.dispatch(
      act("mark_conflict", opt, "rv-207", { actionId: "f-a1", metric: m, detail: d }),
      "f1"
    );
    const r2 = await store.dispatch(
      act("mark_conflict", opt, "rv-207", { actionId: "f-a2", metric: m, detail: d }),
      "f2"
    );
    check("首次登记成功，相同内容第二次被内容幂等拒绝",
      r1.ok === true && r2.ok === false && r2.code === "DUPLICATE_CONFLICT", { r1, r2 });
    let item = itemOf("rv-207");
    const openSame = item.conflicts.filter((c) => c.status === "open" && c.metric === m);
    check("只保留 1 条未关闭冲突", openSame.length === 1, openSame);
    check("只产生 1 条标记审计",
      item.audit.filter((a) => a.kind === "mark_conflict" && a.summary.includes(m)).length === 1);

    // 空白差异不影响判定
    const r3 = await store.dispatch(
      act("mark_conflict", opt2, "rv-207", {
        actionId: "f-a3",
        metric: `  ${m} `,
        detail: `${d}\n`,
      }),
      "f3"
    );
    check("仅首尾空白差异仍判为同一冲突", r3.code === "DUPLICATE_CONFLICT", r3);

    // 不同指标可登记
    const r4 = await store.dispatch(
      act("mark_conflict", opt, "rv-207", { actionId: "f-a4", metric: "左眼轴位差异", detail: d }),
      "f4"
    );
    check("不同指标可以登记", r4.ok === true);
    item = itemOf("rv-207");
    check("未关闭冲突变为 2 条",
      item.conflicts.filter((c) => c.status === "open").length === 2);

    // 同指标但不同说明，也可以登记
    const r5 = await store.dispatch(
      act("mark_conflict", opt, "rv-207", {
        actionId: "f-a5",
        metric: m,
        detail: "另一次复查：2026-03-10 → 2026-06-12 变化 -0.25D",
      }),
      "f5"
    );
    check("同指标不同说明可以登记", r5.ok === true);
    check("未关闭冲突变为 3 条",
      itemOf("rv-207").conflicts.filter((c) => c.status === "open").length === 3);
  }

  // F2. 已关闭冲突 → 相同内容新建被拒，必须显式重开
  console.log("\n[F2] 已关闭的相同冲突需显式重新开启");
  {
    const kv = memoryKV();
    const server = new MockServer(kv, { latencyMs: 0 });
    const store = new ReviewStore(server, kv);
    const m = "PD 瞳距差异";
    const d = "58mm → 60mm，超出 2mm 容差";

    await store.dispatch(act("mark_conflict", opt, "rv-207", {
      actionId: "g-a1", metric: m, detail: d, at: "2026-09-15T10:00:00.000Z",
    }), "g1");
    const cfId = server.getState().items.find((i) => i.id === "rv-207")!.conflicts[0].id;
    await store.dispatch(act("close_conflict", doctor, "rv-207", {
      actionId: "g-a2", conflictId: cfId, at: "2026-09-15T10:05:00.000Z",
    }), "g2");

    const rNew = await store.dispatch(
      act("mark_conflict", opt, "rv-207", {
        actionId: "g-a3", metric: m, detail: d, at: "2026-09-15T10:10:00.000Z",
      }),
      "g3"
    );
    check("对已关闭的同内容冲突再标记 → CONFLICT_RESOLVED（不静默新建）",
      !rNew.ok && rNew.code === "CONFLICT_RESOLVED", rNew);
    const afterReject = server.getState().items.find((i) => i.id === "rv-207")!;
    check("拒绝后冲突仍为 1 条且保持已关闭、无新审计",
      afterReject.conflicts.length === 1 &&
      afterReject.conflicts[0].status === "resolved" &&
      afterReject.audit.filter((a) => a.kind === "mark_conflict").length === 1);

    const rReopen = await store.dispatch(
      act("reopen_conflict", opt2, "rv-207", {
        actionId: "g-a4",
        conflictId: cfId,
        detail: "换片后复测仍不一致",
        at: "2026-09-15T10:15:00.000Z",
      }),
      "g4"
    );
    check("验光师可显式重新开启", rReopen.ok === true);
    const reopened = server.getState().items.find((i) => i.id === "rv-207")!;
    check("冲突回到未关闭，且重新开启人/时间更新为本次提交者",
      reopened.conflicts[0].status === "open" &&
      reopened.conflicts[0].markedByName === "陈验光" &&
      reopened.conflicts[0].markedAt !== afterReject.conflicts[0].markedAt);
    check("重开写有 reopen 审计",
      reopened.audit.some((a) => a.kind === "reopen_conflict" && a.userName === "陈验光"));

    // 重开后同内容再标 → 再次幂等
    const rAgain = await store.dispatch(
      act("mark_conflict", opt, "rv-207", { actionId: "g-a5", metric: m, detail: d }),
      "g5"
    );
    check("重开后同内容再标仍被幂等", rAgain.code === "DUPLICATE_CONFLICT", rAgain);

    // 医生无权重开
    let blocked = false;
    try {
      const s = server.getState();
      const { applyAction } = await import("../src/review/rules");
      applyAction(s, act("reopen_conflict", doctor, "rv-207", { conflictId: cfId }));
    } catch (e) {
      blocked = (e as ReviewError).code === "FORBIDDEN";
    }
    check("医生重新开启冲突 → FORBIDDEN（重开权属验光师）", blocked);
  }

  // F3. 断网重放与刷新后：同内容冲突仍只有一条
  console.log("\n[F3] 断网排队 + 刷新恢复 + 重放：同内容冲突不重复");
  {
    const kv = memoryKV();
    // srv1/st1 是同一标签，给固定 id，刷新后复用
    const srv1 = new MockServer(kv, { latencyMs: 0 });
    const st1 = new ReviewStore(srv1, kv, { clientId: "tab-d" });
    await st1.setOnline(false);
    const m = "离线轴位冲突";
    const d = "OD 轴位 10° → 12°（离线场景）";
    await st1.dispatch(act("mark_conflict", opt, "rv-207", { actionId: "off-1", metric: m, detail: d }), "h1");
    await st1.dispatch(act("mark_conflict", opt2, "rv-207", { actionId: "off-2", metric: m, detail: d }), "h2");
    check("离线第二次同内容不进队列（本地即去重）", st1.getView().outboxCount === 1,
      st1.getView().outboxCount);

    // 模拟刷新（新实例，仍离线；同一标签复用 clientId）
    const srv2 = new MockServer(kv, { latencyMs: 0 });
    const st2 = new ReviewStore(srv2, kv, { clientId: "tab-d" });
    await st2.setOnline(false);
    const itemReload = st2.getView().state.items.find((i) => i.id === "rv-207")!;
    check("刷新后仍只有 1 条同内容未关闭冲突",
      itemReload.conflicts.filter((c) => c.metric === m && c.status === "open").length === 1);

    await st2.setOnline(true);
    const finalItem = srv2.getState().items.find((i) => i.id === "rv-207")!;
    check("重放落库后服务端只有 1 条冲突、1 条标记审计",
      finalItem.conflicts.filter((c) => c.metric === m).length === 1 &&
      finalItem.audit.filter((a) => a.kind === "mark_conflict" && a.summary.includes(m)).length === 1);
  }

  // ───────── G. 跨标签页并发：不同决定都不丢失 ─────────
  console.log("\n[G] 两个标签页并发提交不同决定：全部落库，处理人/时间真实");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect(); // 标签 A
    const kvB = bus.connect(); // 标签 B
    const srvA = new MockServer(kvA, { latencyMs: 0 });
    const srvB = new MockServer(kvB, { latencyMs: 0 });
    const tabA = new ReviewStore(srvA, kvA);
    const tabB = new ReviewStore(srvB, kvB);

    const atA = "2026-09-15T11:00:00.000Z";
    const atB = "2026-09-15T11:00:30.000Z";
    // A：验光师在 rv-207 标记冲突；B：医生同时把 rv-144… 不，选同一事项验证汇聚——
    // B 对 rv-207 转需升级（并发不同类型决定）
    const pA = tabA.dispatch(
      act("mark_conflict", opt, "rv-207", {
        actionId: "tab-A-1",
        at: atA,
        metric: "并发：右眼球镜",
        detail: "标签A 验光师王验光登记",
      }),
      "A1"
    );
    const pB = tabB.dispatch(
      act("to_escalated", doctor, "rv-207", { actionId: "tab-B-1", at: atB }),
      "B1"
    );
    const [resA, resB] = await Promise.all([pA, pB]);
    check("两个并发决定都受理", resA.ok && resB.ok, { resA, resB });

    await new Promise((r) => setTimeout(r, 50)); // 等 storage 事件送达
    const serverState = srvA.getState();
    const item = serverState.items.find((i) => i.id === "rv-207")!;
    check("服务端汇聚两个决定：状态=需升级", item.status === "escalated", item.status);
    check("服务端汇聚两个决定：冲突已登记",
      item.conflicts.some((c) => c.metric === "并发：右眼球镜" && c.status === "open"));
    const markEntry = item.audit.find((a) => a.kind === "mark_conflict")!;
    const escEntry = item.audit.find((a) => a.kind === "to_escalated")!;
    check("处理人/时间与真实提交者一致（王验光 11:00 / 林复查 11:00:30）",
      markEntry.userName === "王验光" && markEntry.at === atA &&
      escEntry.userName === "林复查" && escEntry.at === atB,
      { markEntry, escEntry });
    check("rev 已自增两次", serverState.rev >= 2, serverState.rev);

    // 两标签视图都看到对方的决定
    const viewA = tabA.getView().state.items.find((i) => i.id === "rv-207")!;
    const viewB = tabB.getView().state.items.find((i) => i.id === "rv-207")!;
    check("标签 A 视图包含 B 的需升级流转", viewA.status === "escalated");
    check("标签 B 视图包含 A 登记的冲突",
      viewB.conflicts.some((c) => c.metric === "并发：右眼球镜"));
  }

  // G2. 两标签并发登记【不同指标】冲突 → 两条都保留
  console.log("\n[G2] 两标签并发登记不同冲突：都保留；同内容并发：只一条");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect();
    const kvB = bus.connect();
    const tabA = new ReviewStore(new MockServer(kvA, { latencyMs: 0 }), kvA);
    const tabB = new ReviewStore(new MockServer(kvB, { latencyMs: 0 }), kvB);

    const [rA, rB] = await Promise.all([
      tabA.dispatch(
        act("mark_conflict", opt, "rv-207", {
          actionId: "tab-A-2", metric: "并发指标甲", detail: "说明甲",
        }),
        "A2"
      ),
      tabB.dispatch(
        act("mark_conflict", opt, "rv-207", {
          actionId: "tab-B-2", metric: "并发指标乙", detail: "说明乙",
        }),
        "B2"
      ),
    ]);
    check("两标签不同冲突都成功", rA.ok && rB.ok, { rA, rB });
    await new Promise((r) => setTimeout(r, 50));
    const item = tabA.getView().state.items.find((i) => i.id === "rv-207")!;
    check("两条不同冲突同时存在",
      item.conflicts.some((c) => c.metric === "并发指标甲") &&
      item.conflicts.some((c) => c.metric === "并发指标乙"));

    // 同内容并发（新事项 rv-144，冲突已关闭的种子项；改用 rv-081 上的同指标）
    const bus2 = sharedMemoryKV();
    const k1 = bus2.connect();
    const k2 = bus2.connect();
    const t1 = new ReviewStore(new MockServer(k1, { latencyMs: 0 }), k1);
    const t2 = new ReviewStore(new MockServer(k2, { latencyMs: 0 }), k2);
    const [q1, q2] = await Promise.all([
      t1.dispatch(
        act("mark_conflict", opt, "rv-144", {
          actionId: "same-1", metric: "并发同指标", detail: "完全相同说明",
        }),
        "S1"
      ),
      t2.dispatch(
        act("mark_conflict", opt2, "rv-144", {
          actionId: "same-2", metric: "并发同指标", detail: "完全相同说明",
        }),
        "S2"
      ),
    ]);
    check("同内容并发：恰好一个受理、另一个被内容幂等",
      [q1.ok, q2.ok].filter(Boolean).length === 1, { q1, q2 });
    await new Promise((r) => setTimeout(r, 50));
    const sameItem = t1.getView().state.items.find((i) => i.id === "rv-144")!;
    check("服务端只保留 1 条同内容冲突、1 条审计",
      sameItem.conflicts.filter((c) => c.metric === "并发同指标").length === 1 &&
      sameItem.audit.filter((a) => a.summary.includes("并发同指标")).length === 1);
  }

  // G3. A 离线操作、B 在线操作同一事项，A 恢复后对账，两条决定都不丢
  console.log("\n[G3] 离线标签与在线标签并发：恢复后 rebase，决定互不覆盖");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect();
    const kvB = bus.connect();
    const tabA = new ReviewStore(new MockServer(kvA, { latencyMs: 0 }), kvA);
    const tabB = new ReviewStore(new MockServer(kvB, { latencyMs: 0 }), kvB);

    await tabA.setOnline(false);
    // A 离线：验光师标记冲突
    await tabA.dispatch(
      act("mark_conflict", opt, "rv-207", {
        actionId: "off-A", metric: "离线标签冲突", detail: "A 断网期间登记",
        at: "2026-09-15T12:00:00.000Z",
      }),
      "OA"
    );
    // B 同时在线：医生转待修正（rv-207 无未关闭冲突，合法）
    await tabB.dispatch(
      act("to_pending_fix", doctor, "rv-207", {
        actionId: "on-B", at: "2026-09-15T12:01:00.000Z",
      }),
      "OB"
    );
    await new Promise((r) => setTimeout(r, 30));

    // A 恢复网络：先对账到 B 的落库状态，再重放自己的冲突
    await tabA.setOnline(true);
    await new Promise((r) => setTimeout(r, 50));

    const finalItem = tabA.getView().state.items.find((i) => i.id === "rv-207")!;
    check("A 恢复后：B 的流转保留（待修正）", finalItem.status === "pending_fix", finalItem.status);
    check("A 恢复后：A 离线冲突也已落库",
      finalItem.conflicts.some((c) => c.metric === "离线标签冲突" && c.status === "open"));
    const offEntry = finalItem.audit.find((a) => a.actionId === undefined && a.kind === "mark_conflict" && a.userName === "王验光");
    check("A 的审计处理人/时间是本人提交时刻",
      finalItem.audit.some((a) => a.kind === "mark_conflict" && a.userName === "王验光" &&
        a.at === "2026-09-15T12:00:00.000Z"),
      offEntry);
    check("B 的审计也在",
      finalItem.audit.some((a) => a.kind === "to_pending_fix" && a.userName === "林复查"));
    check("A outbox 清空、无待同步标记",
      tabA.getView().outboxCount === 0 &&
      finalItem.audit.every((a) => !a.pendingSync));

    // 服务端权威状态一致
    const serverItem = new MockServer(kvA, { latencyMs: 0 }).getState()
      .items.find((i) => i.id === "rv-207")!;
    check("服务端最终汇聚两条决定",
      serverItem.status === "pending_fix" &&
      serverItem.conflicts.some((c) => c.metric === "离线标签冲突"));
  }

  // ───────── H. 旧数据迁移 ─────────
  console.log("\n[H] v1 旧数据（服务端/客户端快照）仍可读取并升级到 v2");
  {
    const kv = memoryKV();
    // 手工构造 v1 服务端状态（无 rev；processedActions 值为旧的审计 id 形态）
    const v1 = seedState();
    const legacy: ReviewState = {
      version: 1,
      items: v1.items,
      processedActions: { "old-act-1": "au-001" },
    } as unknown as ReviewState;
    saveState(kv, SERVER_KEY, legacy);

    const loaded = loadState(kv, SERVER_KEY)!;
    check("旧服务端状态可读取并升级为 version 2 / rev 0",
      loaded.version === 2 && loaded.rev === 0, loaded);
    check("旧 processedActions 归一为 actionId 键",
      loaded.processedActions["old-act-1"] === "old-act-1");

    const server = new MockServer(kv, { latencyMs: 0 });
    const st = new ReviewStore(server, kv);
    check("迁移后种子事项数量不丢", st.getView().state.items.length === v1.items.length);
    check("迁移后旧冲突仍在（rv-032 未关闭冲突）",
      st.getView().state.items.find((i) => i.id === "rv-032")!.conflicts[0].status === "open");

    // 迁移后新动作可正常落库并自增 rev
    const r = await st.dispatch(act("to_escalated", doctor, "rv-207", { actionId: "mig-1" }), "m1");
    check("迁移数据上可继续提交决定", r.ok === true);
    const after = server.getState();
    check("提交后 rev 自增、版本保持 2", after.rev === 1 && after.version === 2, after.rev);

    // v1 客户端快照（无 version/outbox/recent）
    const kv2 = memoryKV();
    const v1State = {
      version: 1,
      items: v1.items,
      processedActions: {},
    } as unknown as ReviewState;
    saveJSON(kv2, CLIENT_KEY, { state: v1State, updatedAt: "2026-09-10T00:00:00.000Z" });
    const server2 = new MockServer(kv2, { latencyMs: 0 });
    const st2 = new ReviewStore(server2, kv2);
    check("无 outbox 的旧客户端快照可恢复，outbox 补空",
      st2.getView().state.items.length === v1.items.length && st2.getView().outboxCount === 0);
    const r2 = await st2.dispatch(
      act("mark_conflict", opt, "rv-207", { actionId: "mig-2", metric: "迁移后新冲突", detail: "ok" }),
      "m2"
    );
    check("迁移后的客户端可正常登记冲突", r2.ok === true);
  }

  // ───── I. 多轮并发：两标签反复同时提交不同决定，无丢失无重复 ─────
  console.log("\n[I] 两标签 12 轮反复并发不同决定：全部顺序落库、无丢失/重复，处理人时间真实");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect();
    const kvB = bus.connect();
    const tabA = new ReviewStore(new MockServer(kvA, { latencyMs: 0 }), kvA);
    const tabB = new ReviewStore(new MockServer(kvB, { latencyMs: 0 }), kvB);

    const ROUNDS = 12;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t = `2026-09-15T13:${String(i).padStart(2, "0")}:00.000Z`;
      // A 验光师：每轮登记一条不同指标的冲突
      promises.push(
        tabA.dispatch(
          act("mark_conflict", opt, "rv-207", {
            actionId: `multi-A-${i}`,
            at: t,
            metric: `A 轮次指标 ${i}`,
            detail: `A 第 ${i} 轮说明`,
          }),
          `multi-A-${i}`
        )
      );
      // B 验光师2：也登记不同指标（两条必须同时存在）
      promises.push(
        tabB.dispatch(
          act("mark_conflict", opt2, "rv-207", {
            actionId: `multi-B-${i}`,
            at: `2026-09-15T13:${String(i).padStart(2, "0")}:30.000Z`,
            metric: `B 轮次指标 ${i}`,
            detail: `B 第 ${i} 轮说明`,
          }),
          `multi-B-${i}`
        )
      );
      // 每两对并发之间只等很短，让泵自然串行，不强制对齐
      await Promise.all(promises.slice(-2));
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(promises);
    await new Promise((r) => setTimeout(r, 60));

    const serverItem = new MockServer(kvA, { latencyMs: 0 })
      .getState().items.find((i) => i.id === "rv-207")!;
    check(`服务端汇聚全部 ${ROUNDS * 2} 条不同冲突（无丢失）`,
      serverItem.conflicts.length === ROUNDS * 2, serverItem.conflicts.length);
    const marks = serverItem.audit.filter((a) => a.kind === "mark_conflict");
    check(`标记审计恰好 ${ROUNDS * 2} 条（无重复）`, marks.length === ROUNDS * 2, marks.length);
    check("审计 id 全局唯一（无跨标签计数碰撞）",
      new Set(serverItem.audit.map((a) => a.id)).size === serverItem.audit.length);

    // 处理人与时间逐条核对
    let actorsOk = true;
    for (let i = 0; i < ROUNDS; i++) {
      const aEntry = marks.find((a) => a.summary === `标记冲突：A 轮次指标 ${i}`)!;
      const bEntry = marks.find((a) => a.summary === `标记冲突：B 轮次指标 ${i}`)!;
      if (
        !aEntry || aEntry.userName !== "王验光" ||
        aEntry.at !== `2026-09-15T13:${String(i).padStart(2, "0")}:00.000Z` ||
        !bEntry || bEntry.userName !== "陈验光" ||
        bEntry.at !== `2026-09-15T13:${String(i).padStart(2, "0")}:30.000Z`
      ) {
        actorsOk = false;
      }
    }
    check("每条决定处理人/时间与真实提交者一致", actorsOk);

    // rev：每次提交严格 +1，无覆盖写
    const rev = new MockServer(kvA, { latencyMs: 0 }).getState().rev;
    check("rev 严格等于提交次数（顺序落库）", rev === ROUNDS * 2, rev);

    // 两标签视图与服务端一致（无 pending 残留）
    const viewA = tabA.getView().state.items.find((i) => i.id === "rv-207")!;
    const viewB = tabB.getView().state.items.find((i) => i.id === "rv-207")!;
    check("两标签 outbox 均排空",
      tabA.getView().outboxCount === 0 && tabB.getView().outboxCount === 0);
    check("两标签视图冲突数与服务端一致",
      viewA.conflicts.length === ROUNDS * 2 && viewB.conflicts.length === ROUNDS * 2);
    check("两标签视图无待同步标记",
      viewA.audit.every((a) => !a.pendingSync) && viewB.audit.every((a) => !a.pendingSync));
  }

  // I2. 高竞争：一次性 20 条不同决定无间隔并发
  console.log("\n[I2] 20 条不同决定同毫秒并发：全部落库，顺序由存储锁保证");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect();
    const kvB = bus.connect();
    const tabA = new ReviewStore(new MockServer(kvA, { latencyMs: 0 }), kvA);
    const tabB = new ReviewStore(new MockServer(kvB, { latencyMs: 0 }), kvB);
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      all.push(tabA.dispatch(
        act("mark_conflict", opt, "rv-144", {
          actionId: `burst-A-${i}`, metric: `突发A${i}`, detail: "x",
        }),
        `bA${i}`
      ));
      all.push(tabB.dispatch(
        act("mark_conflict", opt2, "rv-144", {
          actionId: `burst-B-${i}`, metric: `突发B${i}`, detail: "y",
        }),
        `bB${i}`
      ));
    }
    const rs = await Promise.all(all);
    await new Promise((r) => setTimeout(r, 80));
    check("20 条并发全部返回受理", rs.every((r) => (r as { ok: boolean }).ok));
    const item = new MockServer(kvA, { latencyMs: 0 }).getState()
      .items.find((i) => i.id === "rv-144")!;
    const burstConflicts = item.conflicts.filter((c) => /突发[AB]\d/.test(c.metric));
    check("服务端 20 条冲突都在（无丢失）", burstConflicts.length === 20, burstConflicts.length);
    check("20 条审计都在（无重复）",
      item.audit.filter((a) => /标记冲突：突发[AB]\d/.test(a.summary)).length === 20);
    check("rev=20（零覆盖写）",
      new MockServer(kvA, { latencyMs: 0 }).getState().rev === 20);
  }

  // I3. 同 actionId 跨标签并发：只生效一次
  console.log("\n[I3] 同 actionId 跨标签并发；同内容冲突跨标签并发：各只一次");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect();
    const kvB = bus.connect();
    const tabA = new ReviewStore(new MockServer(kvA, { latencyMs: 0 }), kvA);
    const tabB = new ReviewStore(new MockServer(kvB, { latencyMs: 0 }), kvB);
    // 同 actionId 的两个实例（A、B 各自本地都通过）
    const shared: Partial<ReviewAction> = {
      actionId: "shared-id-1", metric: "同ID指标", detail: "同ID说明",
    };
    const [rA, rB] = await Promise.all([
      tabA.dispatch(act("mark_conflict", opt, "rv-207", shared), "sh1"),
      tabB.dispatch(act("mark_conflict", opt, shared), "sh2"),
    ]);
    await new Promise((r) => setTimeout(r, 60));
    check("同 actionId：恰好一条受理",
      [rA.ok, rB.ok].filter(Boolean).length === 1, { rA, rB });
    const item = new MockServer(kvA, { latencyMs: 0 }).getState()
      .items.find((i) => i.id === "rv-207")!;
    check("同 actionId：服务端仅 1 条冲突 1 条审计",
      item.conflicts.filter((c) => c.metric === "同ID指标").length === 1 &&
      item.audit.filter((a) => a.summary.includes("同ID指标")).length === 1);
  }

  // ───── J. 锁故障：崩溃标签遗留陈旧锁、等待超时，均不永久阻塞 ─────
  console.log("\n[J] 陈旧锁 TTL 接管 / 等待超时入队重试 / 发送中关闭标签");
  {
    // J1 崩溃标签遗留陈旧锁
    const kv = memoryKV();
    const server = new MockServer(kv, {
      latencyMs: 0,
      lock: { ttlMs: 50, waitMs: 500, retryMs: 10 },
    });
    kv.setItem(LOCK_KEY, JSON.stringify({ owner: "dead-tab-owner", at: Date.now() - 5_000 }));
    const r = await server.dispatch(act("to_escalated", doctor, "rv-207", { actionId: "j1" }));
    check("陈旧锁（已过 TTL）可被接管，提交正常", r.deduped === false);
    check("提交后陈旧锁被新主释放", kv.getItem(LOCK_KEY) === null);

    // J2 活跃的他人锁：等待超时 → LOCK_BUSY，动作不丢，稍后重试成功
    const kv2 = memoryKV();
    const server2 = new MockServer(kv2, {
      latencyMs: 0,
      lock: { ttlMs: 10_000, waitMs: 120, retryMs: 20 },
    });
    kv2.setItem(LOCK_KEY, JSON.stringify({ owner: "other-live", at: Date.now() }));
    let busy = false;
    try {
      await server2.dispatch(act("to_escalated", doctor, "rv-207", { actionId: "j2" }));
    } catch (e) {
      busy = (e as ReviewError).code === "LOCK_BUSY";
    }
    check("锁等待超时返回 LOCK_BUSY（不永久挂起）", busy);
    check("LOCK_BUSY 期间服务端状态未被污染",
      server2.getState().items.find((i) => i.id === "rv-207")!.status === "open");

    // 通过 store：锁忙时动作进 outbox，锁释放后自动重试落库（不丢失）
    const store = new ReviewStore(server2, kv2);
    const res = await store.dispatch(
      act("to_escalated", doctor, "rv-207", { actionId: "j3" }),
      "j3"
    );
    check("锁忙时提交被受理（已排队）", res.ok === true);
    check("锁忙时动作保留在 outbox", store.getView().outboxCount === 1);
    kv2.removeItem(LOCK_KEY); // 持锁标签恢复/释放
    await store.flushed();
    // 等待自动退避重试
    await new Promise((r) => setTimeout(r, 700));
    check("锁释放后排队动作自动落库（无丢失）",
      server2.getState().items.find((i) => i.id === "rv-207")!.status === "escalated");
    check("落库后 outbox 排空", store.getView().outboxCount === 0);

    // J3 发送前"标签关闭"：动作已先持久化在本标签 outbox 键，失活后由新标签接管补传
    const bus = sharedMemoryKV();
    const kvC = bus.connect();
    const tabC = new ReviewStore(new MockServer(kvC, { latencyMs: 0 }), kvC, {
      clientId: "tab-ghost",
    });
    await tabC.setOnline(false);
    await tabC.dispatch(
      act("mark_conflict", opt, "rv-207", {
        actionId: "ghost-1", metric: "关闭前排队", detail: "发送前已持久化",
      }),
      "ghost1"
    );
    tabC.closeClient(); // 模拟标签被直接关闭：心跳停止，本地键保留
    const persisted = loadLocalData(kvC, "tab-ghost")!;
    check("离线动作在发送前已写入本标签 outbox 键",
      persisted.outbox.some((q) => q.action.actionId === "ghost-1"));
    // 心跳回退到 10 秒前，模拟该标签已失活超过接管阈值
    saveLocalData(kvC, { ...persisted, heartbeat: Date.now() - 10_000 });

    // 新标签打开：构造时扫描并接管失活队列（网络已恢复）
    const kvD = bus.connect();
    const srvD = new MockServer(kvD, { latencyMs: 0 });
    const tabD = new ReviewStore(srvD, kvD, { clientId: "tab-savior" });
    await tabD.setOnline(true);
    await tabD.flushed();
    await new Promise((r) => setTimeout(r, 80));
    check("新标签自动接管并补传关闭前动作，服务端仅 1 条",
      srvD.getState().items.find((i) => i.id === "rv-207")!.conflicts
        .filter((c) => c.metric === "关闭前排队").length === 1);
    check("接管后失活标签的本地键已删除（不会被重复接管）",
      kvC.getItem(localKey("tab-ghost")) === null);
    check("接管者 outbox 排空", tabD.getView().outboxCount === 0);
  }

  // ───── K. 多轮并发后的刷新一致性 ─────
  console.log("\n[K] 多轮并发后刷新：两新实例与服务端完全一致");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect();
    const kvB = bus.connect();
    const tabA = new ReviewStore(new MockServer(kvA, { latencyMs: 0 }), kvA);
    const tabB = new ReviewStore(new MockServer(kvB, { latencyMs: 0 }), kvB);
    for (let i = 0; i < 6; i++) {
      await Promise.all([
        tabA.dispatch(act("mark_conflict", opt, "rv-207", {
          actionId: `k-A-${i}`, metric: `K甲${i}`, detail: "a",
        }), `kA${i}`),
        tabB.dispatch(act("mark_conflict", opt2, "rv-207", {
          actionId: `k-B-${i}`, metric: `K乙${i}`, detail: "b",
        }), `kB${i}`),
      ]);
    }
    await new Promise((r) => setTimeout(r, 60));
    const serverState = new MockServer(kvA, { latencyMs: 0 }).getState();

    // 两个"新标签"实例（模拟各自刷新）
    const kvA2 = bus.connect();
    const kvB2 = bus.connect();
    const freshA = new ReviewStore(new MockServer(kvA2, { latencyMs: 0 }), kvA2);
    const freshB = new ReviewStore(new MockServer(kvB2, { latencyMs: 0 }), kvB2);
    await Promise.all([freshA.flushed(), freshB.flushed()]);
    const cmp = (s: typeof serverState) => ({
      rev: s.rev,
      conflicts: s.items.find((i) => i.id === "rv-207")!.conflicts.length,
      audits: s.items.find((i) => i.id === "rv-207")!.audit.length,
    });
    check("刷新实例 A 与服务端一致（rev/冲突/审计数）",
      JSON.stringify(cmp(freshA.getView().state)) === JSON.stringify(cmp(serverState)));
    check("刷新实例 B 与服务端一致",
      JSON.stringify(cmp(freshB.getView().state)) === JSON.stringify(cmp(serverState)));
    check("新实例无遗留 outbox/待同步",
      freshA.getView().outboxCount === 0 && freshB.getView().outboxCount === 0 &&
      freshA.getView().state.items.find((i) => i.id === "rv-207")!.audit
        .every((a) => !a.pendingSync));
  }

  // ───── L. 带网络延迟的多轮并发（贴合浏览器 180ms 延迟） ─────
  console.log("\n[L] 180ms 网络延迟下两标签 8 轮快速并发：无丢失、无重复、无假性同步");
  {
    const bus = sharedMemoryKV();
    const kvA = bus.connect();
    const kvB = bus.connect();
    const tabA = new ReviewStore(new MockServer(kvA, { latencyMs: 180 }), kvA, { clientId: "lat-A" });
    const tabB = new ReviewStore(new MockServer(kvB, { latencyMs: 180 }), kvB, { clientId: "lat-B" });
    const ROUNDS = 8;
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      all.push(tabA.dispatch(act("mark_conflict", opt, "rv-207", {
        actionId: `lat-A-${i}`, metric: `延迟甲${i}`, detail: "a",
      }), `lA${i}`));
      all.push(tabB.dispatch(act("mark_conflict", opt2, "rv-207", {
        actionId: `lat-B-${i}`, metric: `延迟乙${i}`, detail: "b",
      }), `lB${i}`));
    }
    await Promise.all(all);
    await Promise.all([tabA.flushed(), tabB.flushed()]);
    // 等锁忙退避可能触发的补传完成
    await new Promise((r) => setTimeout(r, 600));
    await Promise.all([tabA.flushed(), tabB.flushed()]);

    const final = new MockServer(kvA, { latencyMs: 0 }).getState();
    const item = final.items.find((i) => i.id === "rv-207")!;
    check(`180ms 延迟下 ${ROUNDS * 2} 条决定全部落库（无丢失）`,
      item.conflicts.length === ROUNDS * 2, item.conflicts.length);
    const marks = item.audit.filter((a) => a.kind === "mark_conflict");
    check("标记审计无重复", marks.length === ROUNDS * 2, marks.length);
    check("rev 严格等于提交数", final.rev === ROUNDS * 2, final.rev);
    check("两标签 outbox 排空、无待同步标记",
      tabA.getView().outboxCount === 0 && tabB.getView().outboxCount === 0 &&
      tabA.getView().state.items.find((i) => i.id === "rv-207")!.audit.every((a) => !a.pendingSync));
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
