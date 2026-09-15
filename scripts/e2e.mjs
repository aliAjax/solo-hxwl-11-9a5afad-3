/* 真实浏览器 E2E：权限、越级流转、冲突门禁、重复点击、断网→刷新→恢复 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5111/";
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function auditCount(page) {
  return page.locator(".item-panel .audit-item").count();
}

async function main() {
  const browser = await chromium.launch();
  // 所有标签页必须在同一 BrowserContext 内，才与真实浏览器一样共享 localStorage
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForSelector(".item-panel");

  // 默认验光师王验光，队列首项 rv-032（含 1 条未关闭冲突）
  console.log("\n[E1] 验光师：只能标记冲突，流转按钮全部越级禁用");
  {
    const confirm = page.getByRole("button", { name: "确认处方" });
    const fix = page.getByRole("button", { name: "转待修正" });
    const esc = page.getByRole("button", { name: "转需升级" });
    ok("确认/待修正/需升级按钮对验光师禁用",
      (await confirm.isDisabled()) && (await fix.isDisabled()) && (await esc.isDisabled()));
    ok("提示验光师不能越级流转",
      (await page.locator(".flow-box .role-hint").textContent()).includes("验光师只能标记冲突"));

    const audits0 = await auditCount(page);
    // 手动表单标记冲突
    await page.locator(".mark-form input").nth(0).fill("左眼轴位抽查");
    await page.locator(".mark-form input").nth(1).fill("E2E：170° 与既往 178° 偏差需复核");
    await page.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    await page.waitForFunction(
      (n) => document.querySelectorAll(".item-panel .audit-item").length === n,
      audits0 + 1
    );
    ok("标记冲突后审计 +1 且处理人为王验光",
      (await page.locator(".item-panel .audit-item").last().locator(".audit-user").textContent()).includes("王验光"));
    const openFlags = await page.locator(".conflict-card.open").count();
    ok("未关闭冲突变为 2 条", openFlags === 2, openFlags);
  }

  console.log("\n[E2] 门店顾问：只读");
  {
    await page.locator("select").selectOption({ index: 3 }); // 赵顾问
    ok("顾问看不到可用的标记/关闭/流转按钮",
      (await page.getByRole("button", { name: "确认处方" }).isDisabled()) &&
      (await page.locator(".mark-form button").isDisabled()) &&
      (await page.locator(".conflict-actions button").count()) === 0);
    await page.locator("select").selectOption({ index: 1 }); // 回到王验光
  }

  console.log("\n[E3] 复查医生：冲突未关闭不能确认，越级路径被锁");
  {
    await page.locator("select").selectOption({ index: 0 }); // 林复查
    await page.waitForSelector(".flow-btn");
    ok("门禁提示存在 2 条未关闭冲突",
      (await page.locator(".guard.bad").textContent()).includes("2 条未关闭冲突"));
    ok("确认按钮禁用", await page.getByRole("button", { name: "确认处方" }).isDisabled());

    // 医生不能标记冲突（手动表单禁用）
    ok("医生的标记冲突表单禁用（标记权仅验光师）",
      await page.locator(".mark-form button").isDisabled());

    // 关闭全部未关闭冲突
    let guard = 0;
    while ((await page.locator(".conflict-card.open .conflict-actions button").count()) > 0 && guard < 5) {
      await page.locator(".conflict-card.open .conflict-actions button").first().click();
      await page.locator(".conflict-card.open input").last().fill("E2E 复核无异议");
      await page.getByRole("button", { name: "确认关闭" }).click();
      await sleep(300);
      guard++;
    }
    ok("2 条冲突均已关闭", (await page.locator(".conflict-card.open").count()) === 0);
    ok("门禁变为可确认", (await page.locator(".guard.ok").first().textContent()).includes("可确认"));

    const audits0 = await auditCount(page);
    await page.getByRole("button", { name: "确认处方" }).click();
    await page.waitForFunction(
      (n) => document.querySelectorAll(".item-panel .audit-item").length === n,
      audits0 + 1
    );
    ok("状态变为已确认",
      (await page.locator(".item-panel .status-badge").first().textContent()).includes("已确认"));
    const lastAudit = page.locator(".item-panel .audit-item").last();
    ok("确认记录含处理人林复查",
      (await lastAudit.locator(".audit-user").textContent()).includes("林复查"));
    ok("确认记录含时间",
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(await lastAudit.locator(".audit-time").textContent()));
    ok("确认后所有流转按钮禁用（终态）",
      (await page.getByRole("button", { name: "转待修正" }).isDisabled()) &&
      (await page.getByRole("button", { name: "转需升级" }).isDisabled()));
  }

  console.log("\n[E4] 重复点击只生效一次（rv-207 快速双击转需升级）");
  {
    await page.locator(".item-row", { hasText: "Patient-207" }).click();
    await page.waitForTimeout(200);
    const before = await auditCount(page);
    const btn = page.getByRole("button", { name: "转需升级" });
    await btn.click({ clickCount: 2 }).catch(() => {});
    await sleep(700);
    const after = await auditCount(page);
    ok("双击只新增 1 条审计", after === before + 1, { before, after });
    const escEntries = await page.locator(".item-panel .audit-item").evaluateAll(
      (els) => els.filter((e) => e.textContent.includes("流转：需升级")).length
    );
    ok("需升级记录恰好 1 条", escEntries === 1, escEntries);
  }

  console.log("\n[E5] 断网操作 → 刷新 → 状态/记录恢复 → 恢复网络自动同步且无重复");
  {
    // 仍在 rv-207（需升级态，无冲突）；断网
    await page.getByRole("button", { name: /在线/ }).click();
    await page.waitForSelector("button.net.offline");
    // 离线：医生转待修正
    const before = await auditCount(page);
    await page.getByRole("button", { name: "转待修正" }).click();
    await page.waitForSelector(".pending-tag");
    ok("离线操作即时生效并标记待同步",
      (await page.locator(".item-panel .status-badge").first().textContent()).includes("待修正"));
    ok("待同步标签出现", (await page.locator(".pending-tag").count()) >= 1);

    // 离线：切验光师再标一条冲突
    await page.locator("select").selectOption({ index: 1 });
    await page.locator(".mark-form input").nth(0).fill("离线标记：PD 复测差异");
    await page.locator(".mark-form input").nth(1).fill("E2E 离线暂存");
    await page.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    await sleep(300);
    const offlineAudits = await auditCount(page);
    ok("离线审计共新增 2 条", offlineAudits === before + 2, { before, offlineAudits });

    // 刷新页面
    await page.reload();
    await page.waitForSelector(".item-panel");
    await page.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await sleep(200);
    ok("刷新后状态恢复为待修正",
      (await page.locator(".item-panel .status-badge").first().textContent()).includes("待修正"));
    ok("刷新后待同步记录恢复", (await page.locator(".pending-tag").count()) >= 2);
    ok("刷新后处理人与时间完整",
      (await page.locator(".item-panel .audit-item").last().locator(".audit-user").textContent()).includes("王验光"));
    ok("断网角标显示待同步条数",
      /\d/.test(await page.locator("button.net b").textContent()));

    // 恢复网络（默认身份是验光师，重放不依赖前端身份）
    await page.getByRole("button", { name: /断网模拟中/ }).click();
    await page.waitForSelector("button.net.online", { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelectorAll(".pending-tag").length === 0,
      null,
      { timeout: 5000 }
    );
    ok("同步后待同步标记消失", true);
    const syncedAudits = await auditCount(page);
    ok("重放后审计无重复（仍为离线时条数）", syncedAudits === offlineAudits,
      { offlineAudits, syncedAudits });
    ok("最终状态仍为待修正，离线冲突已同步为未关闭",
      (await page.locator(".item-panel .status-badge").first().textContent()).includes("待修正") &&
      (await page.locator(".conflict-card.open").count()) === 1);
    ok("成功通知出现",
      (await page.locator(".notice.success").textContent()).includes("同步"));

    // 再刷新一次：以服务端权威状态启动，无 pending、无 outbox
    await page.reload();
    await page.waitForSelector(".item-panel");
    await page.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await sleep(300);
    ok("二次刷新无待同步残留", (await page.locator(".pending-tag").count()) === 0);
    ok("二次刷新审计条数一致", (await auditCount(page)) === syncedAudits);
  }

  console.log("\n[E6] 两个标签页并发提交不同决定：两条都保留，处理人/时间真实");
  {
    await page.getByRole("button", { name: "重置演示" }).click();
    await sleep(300);
    await page.locator(".item-row", { hasText: "Patient-207" }).click();
    await page.locator("select").selectOption({ index: 1 }); // 王验光

    const page2 = await context.newPage();
    await page2.goto(BASE);
    await page2.waitForSelector(".item-panel");
    await page2.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await page2.locator("select").selectOption({ index: 0 }); // 林复查

    // 标签 A：验光师标记冲突；标签 B：医生转需升级 —— 同时提交
    await page.locator(".mark-form input").nth(0).fill("双标签并发冲突");
    await page.locator(".mark-form input").nth(1).fill("A 标签王验光登记");
    const tA = page.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    const tB = page2.getByRole("button", { name: "转需升级" }).click();
    await Promise.all([tA, tB]);
    await sleep(700);

    const statusA = await page.locator(".item-panel .status-badge").first().textContent();
    const statusB = await page2.locator(".item-panel .status-badge").first().textContent();
    ok("两标签都看到 需升级（并发流转不丢）",
      statusA.includes("需升级") && statusB.includes("需升级"), { statusA, statusB });
    ok("两标签都看到 A 登记的冲突",
      (await page.locator(".conflict-card.open", { hasText: "双标签并发冲突" }).count()) === 1 &&
      (await page2.locator(".conflict-card.open", { hasText: "双标签并发冲突" }).count()) === 1);
    const users = await page.locator(".item-panel .audit-user").allInnerTexts();
    ok("处理记录同时保留王验光与林复查",
      users.some((u) => u.includes("王验光")) && users.some((u) => u.includes("林复查")),
      users);
    const kinds = await page.locator(".item-panel .audit-item").evaluateAll(
      (els) => els.map((e) => e.textContent)
    );
    ok("两类决定各恰好 1 条",
      kinds.filter((t) => t.includes("标记冲突：双标签并发冲突")).length === 1 &&
      kinds.filter((t) => t.includes("流转：需升级")).length === 1);
    await page2.close();
  }

  console.log("\n[E7] 两标签并发提交相同内容冲突：只保留一条");
  {
    await page.getByRole("button", { name: "重置演示" }).click();
    await sleep(300);
    await page.locator(".item-row", { hasText: "Patient-207" }).click();
    await page.locator("select").selectOption({ index: 1 }); // 王验光

    const p2 = await context.newPage();
    await p2.goto(BASE);
    await p2.waitForSelector(".item-panel");
    await p2.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await p2.locator("select").selectOption({ index: 2 }); // 陈验光

    for (const pg of [page, p2]) {
      await pg.locator(".mark-form input").nth(0).fill("同内容并发指标");
      await pg.locator(".mark-form input").nth(1).fill("两标签完全相同的说明");
    }
    await Promise.all([
      page.getByRole("button", { name: "标记冲突", exact: true }).last().click(),
      p2.getByRole("button", { name: "标记冲突", exact: true }).last().click(),
    ]);
    await sleep(700);

    ok("标签 A 只显示 1 条同内容冲突",
      (await page.locator(".conflict-card.open", { hasText: "同内容并发指标" }).count()) === 1);
    ok("标签 B 也只显示 1 条（被内容幂等）",
      (await p2.locator(".conflict-card.open", { hasText: "同内容并发指标" }).count()) === 1);
    const marks = await page.locator(".item-panel .audit-item").evaluateAll(
      (els) => els.filter((e) => e.textContent.includes("标记冲突：同内容并发指标")).length
    );
    ok("对应审计只有 1 条", marks === 1, marks);

    // 不同指标仍可在 B 标签登记，且 A 能看到
    await p2.locator(".mark-form input").nth(0).fill("另一个指标");
    await p2.locator(".mark-form input").nth(1).fill("不同内容说明");
    await p2.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    await sleep(600);
    ok("并发后不同指标可继续登记且跨标签可见",
      (await page.locator(".conflict-card.open", { hasText: "另一个指标" }).count()) === 1);
    await p2.close();
  }

  console.log("\n[E8] 已关闭冲突必须显式重新开启；重开后确认重新被锁");
  {
    await page.getByRole("button", { name: "重置演示" }).click();
    await sleep(300);
    await page.locator(".item-row", { hasText: "Patient-032" }).click();

    // 医生关闭 rv-032 的未关闭冲突
    await page.locator("select").selectOption({ index: 0 });
    await page.locator(".conflict-card.open .conflict-actions button").first().click();
    await page.locator(".conflict-card.open input").last().fill("E2E 复核无异议");
    await page.getByRole("button", { name: "确认关闭" }).click();
    await sleep(400);
    ok("冲突已关闭，医生看不到重新开启按钮",
      (await page.locator(".conflict-card.resolved").count()) === 1 &&
      (await page.getByRole("button", { name: "重新开启" }).count()) === 0);

    // 切验光师：可重新开启
    await page.locator("select").selectOption({ index: 2 }); // 陈验光
    await page.getByRole("button", { name: "重新开启" }).click();
    await page.locator(".conflict-actions input").last().fill("复测仍矛盾");
    await page.getByRole("button", { name: "确认重新开启" }).click();
    await sleep(400);
    ok("冲突重新变为未关闭",
      (await page.locator(".conflict-card.open").count()) === 1);
    const timeline = await page.locator(".item-panel .audit-item").allInnerTexts();
    ok("时间线含重新开启记录（陈验光）",
      timeline.some((t) => t.includes("重新开启冲突") && t.includes("陈验光")));

    // 重开后医生确认再次被锁
    await page.locator("select").selectOption({ index: 0 });
    ok("重开后确认按钮重新禁用",
      await page.getByRole("button", { name: "确认处方" }).isDisabled());
    ok("门禁再次提示未关闭冲突",
      (await page.locator(".guard.bad").textContent()).includes("1 条未关闭冲突"));
  }

  console.log("\n[E9] v1 旧数据迁移：升级后可读、可操作");
  {
    // 把当前服务端状态降级成 v1（去 rev、version=1），清掉客户端快照后刷新
    await page.evaluate(() => {
      const raw = localStorage.getItem("rx-review/server-state/v1");
      const s = JSON.parse(raw);
      delete s.rev;
      s.version = 1;
      s.processedActions = { "legacy-act": "au-old" };
      localStorage.setItem("rx-review/server-state/v1", JSON.stringify(s));
      localStorage.removeItem("rx-review/client-snapshot/v1");
    });
    await page.reload();
    await page.waitForSelector(".item-panel");
    ok("旧版数据下页面正常渲染 4 个队列事项",
      (await page.locator(".item-row").count()) === 4);
    ok("旧版冲突状态保留（Patient-032 有未关闭冲突）",
      (await page.locator(".item-row", { hasText: "Patient-032" }).textContent()).includes("冲突 1"));

    // 迁移后操作可用：验光师登记一条冲突
    await page.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await page.locator("select").selectOption({ index: 1 });
    await page.locator(".mark-form input").nth(0).fill("迁移后新指标");
    await page.locator(".mark-form input").nth(1).fill("迁移后仍可登记");
    await page.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    await sleep(500);
    ok("迁移数据上可继续登记冲突",
      (await page.locator(".conflict-card.open", { hasText: "迁移后新指标" }).count()) === 1);
    const upgraded = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("rx-review/server-state/v1"));
      return { version: s.version, rev: s.rev, legacy: s.processedActions["legacy-act"] };
    });
    ok("写回后数据已升级为 v2 且 rev 自增、旧幂等键保留",
      upgraded.version === 2 && upgraded.rev === 1 && upgraded.legacy === "legacy-act",
      upgraded);
    // 再刷新：v2 数据继续可用
    await page.reload();
    await page.waitForSelector(".item-panel");
    await page.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await sleep(300);
    ok("迁移后二次刷新数据完整",
      (await page.locator(".conflict-card.open", { hasText: "迁移后新指标" }).count()) === 1);
  }

  console.log("\n[E10] 两真实标签 5 轮反复并发不同决定：无丢失、无重复、刷新一致");
  {
    await page.getByRole("button", { name: "重置演示" }).click();
    await sleep(300);
    await page.locator(".item-row", { hasText: "Patient-207" }).click();
    await page.locator("select").selectOption({ index: 1 }); // 王验光

    const t2 = await context.newPage();
    await t2.goto(BASE);
    await t2.waitForSelector(".item-panel");
    await t2.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await t2.locator("select").selectOption({ index: 2 }); // 陈验光

    const mark = async (pg, metric, detail) => {
      await pg.locator(".mark-form input").nth(0).fill(metric);
      await pg.locator(".mark-form input").nth(1).fill(detail);
      await pg.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    };

    const ROUNDS = 5;
    for (let i = 0; i < ROUNDS; i++) {
      await Promise.all([
        mark(page, `多轮甲${i}`, `甲第${i}轮说明`),
        mark(t2, `多轮乙${i}`, `乙第${i}轮说明`),
      ]);
      // 每轮等待两标签视图都汇聚到应有条数（无丢失即必须增长）
      await page.waitForFunction(
        (n) => document.querySelectorAll(".conflict-card.open").length >= n,
        2 * (i + 1),
        { timeout: 8000 }
      );
      await t2.waitForFunction(
        (n) => document.querySelectorAll(".conflict-card.open").length >= n,
        2 * (i + 1),
        { timeout: 8000 }
      );
    }
    await sleep(300);

    const countOn = async (pg, text) =>
      pg.locator(".conflict-card.open", { hasText: text }).count();
    let allPresent = true;
    for (let i = 0; i < ROUNDS; i++) {
      if ((await countOn(page, `多轮甲${i}`)) !== 1) allPresent = false;
      if ((await countOn(page, `多轮乙${i}`)) !== 1) allPresent = false;
    }
    ok("标签 A：10 条冲突全部存在且各只 1 条（无丢失/重复）", allPresent);
    ok("标签 B 视图同样汇聚 10 条",
      (await t2.locator(".conflict-card.open").count()) === 10);

    const auditTexts = await page.locator(".item-panel .audit-item").allInnerTexts();
    const marks = auditTexts.filter((t) => t.includes("标记冲突：多轮"));
    ok("标记审计恰好 10 条，无重复", marks.length === 10, marks.length);
    ok("审计中两位处理人都在",
      auditTexts.some((t) => t.includes("王验光")) && auditTexts.some((t) => t.includes("陈验光")));
    ok("两标签 outbox 均已排空（无待同步标记）",
      (await page.locator(".pending-tag").count()) === 0 &&
      (await t2.locator(".pending-tag").count()) === 0);

    // 服务端 rev=10
    const rev = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("rx-review/server-state/v1")).rev);
    ok("服务端 rev=10（顺序落库，零覆盖）", rev === 10, rev);

    // 两个标签各自刷新：仍为 10 条、无待同步
    await Promise.all([page.reload(), t2.reload()]);
    await Promise.all([page.waitForSelector(".item-panel"), t2.waitForSelector(".item-panel")]);
    await Promise.all([
      page.locator(".item-row", { hasText: "Patient-207" }).first().click(),
      t2.locator(".item-row", { hasText: "Patient-207" }).first().click(),
    ]);
    await sleep(400);
    ok("刷新后两标签仍各见 10 条冲突",
      (await page.locator(".conflict-card.open").count()) === 10 &&
      (await t2.locator(".conflict-card.open").count()) === 10);
    ok("刷新后无待同步残留",
      (await page.locator(".pending-tag").count()) === 0 &&
      (await t2.locator(".pending-tag").count()) === 0);
    await t2.close();
  }

  console.log("\n[E11] 陈旧锁不永久阻塞；关闭标签遗留队列被新标签接管");
  {
    await page.getByRole("button", { name: "重置演示" }).click();
    await sleep(300);
    await page.locator(".item-row", { hasText: "Patient-207" }).click();
    await page.locator("select").selectOption({ index: 1 });

    // 1) 注入一个已过 TTL 的陈旧锁（模拟崩溃标签没释放）
    await page.evaluate(() => {
      localStorage.setItem("rx-review/server-lock/v1",
        JSON.stringify({ owner: "dead-owner", at: Date.now() - 10_000 }));
    });
    await page.locator(".mark-form input").nth(0).fill("陈旧锁后提交");
    await page.locator(".mark-form input").nth(1).fill("应自动接管锁并落库");
    await page.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    await sleep(700);
    ok("陈旧锁被接管，提交正常落库（不永久阻塞）",
      (await page.locator(".conflict-card.open", { hasText: "陈旧锁后提交" }).count()) === 1);
    const lockCleared = await page.evaluate(
      () => localStorage.getItem("rx-review/server-lock/v1") === null);
    ok("落库后锁已释放", lockCleared);

    // 2) 关闭标签接管：ghost 标签离线排队一条，随后"失活"，新标签打开后接管补传
    const ghost = await context.newPage();
    await ghost.goto(BASE);
    await ghost.waitForSelector(".item-panel");
    await ghost.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await ghost.locator("select").selectOption({ index: 2 }); // 陈验光
    await ghost.getByRole("button", { name: /在线/ }).click(); // 断网
    await ghost.waitForSelector("button.net.offline");
    await ghost.locator(".mark-form input").nth(0).fill("幽灵标签遗留");
    await ghost.locator(".mark-form input").nth(1).fill("关闭后应由新标签接管");
    await ghost.getByRole("button", { name: "标记冲突", exact: true }).last().click();
    await sleep(300);

    // 把 ghost 标签的本地键心跳改为 10 秒前（模拟已关闭失活）
    await ghost.evaluate(() => {
      const prefix = "rx-review/client/v2#";
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const d = JSON.parse(localStorage.getItem(k));
          d.heartbeat = Date.now() - 10_000;
          localStorage.setItem(k, JSON.stringify(d));
        }
      }
    });
    await ghost.close(); // 标签真正关闭

    // 新标签打开（全局仍离线），构造时即接管失活队列；再手动恢复网络触发补传
    const savior = await context.newPage();
    await savior.goto(BASE);
    await savior.waitForSelector(".item-panel");
    await sleep(300); // 等接管扫描（构造时执行一次）
    await savior.getByRole("button", { name: /断网模拟中/ }).click();
    await savior.waitForSelector("button.net.online", { timeout: 5000 });
    await sleep(1000); // 等接管动作锁内落库
    await savior.locator(".item-row", { hasText: "Patient-207" }).first().click();
    await sleep(300);
    ok("新标签接管关闭标签遗留决定并补传，服务端仅 1 条",
      (await savior.locator(".conflict-card.open", { hasText: "幽灵标签遗留" }).count()) === 1);
    ok("接管后无待同步残留",
      (await savior.locator(".pending-tag").count()) === 0);
    const leftover = await savior.evaluate(() => {
      const prefix = "rx-review/client/v2#";
      let found = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const d = JSON.parse(localStorage.getItem(k));
          if ((d.outbox || []).some((q) => q.action.metric === "幽灵标签遗留")) found++;
        }
      }
      return found;
    });
    ok("遗留动作已从所有标签 outbox 摘除（失活键被清理，不会重复接管）",
      leftover === 0, leftover);
    await savior.close();
  }

  ok("全程无页面 JS 异常", errors.length === 0, errors);

  await browser.close();
  console.log(`\nE2E 结果：${pass} 通过，${fail} 失败\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
