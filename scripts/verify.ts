/* 验证脚本：权限 / 越级流转 / 冲突门禁 / 重复处理幂等 / 断网+刷新恢复 */
import { applyAction } from "../src/review/rules";
import { seedState, USERS } from "../src/review/seed";
import { MockServer } from "../src/review/server";
import { ReviewStore } from "../src/review/store";
import { memoryKV } from "../src/review/storage";
import { CLIENT_KEY, SERVER_KEY, loadJSON, loadState } from "../src/review/storage";
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
    );
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
    const s1 = applyAction(s0, a);
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

    const snap = loadJSON<{ outbox: unknown[] }>(kv, CLIENT_KEY)!;
    check("客户端快照已持久化 outbox（3 条）", Array.isArray(snap.outbox) && snap.outbox.length === 3);

    // 刷新：全新 server/store 实例（模拟页面重开，此时网络仍未恢复）
    const server2 = new MockServer(kv, { latencyMs: 0 });
    const store2 = new ReviewStore(server2, kv);
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

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
