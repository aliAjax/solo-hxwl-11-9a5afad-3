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
  const page = await browser.newPage();
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

  ok("全程无页面 JS 异常", errors.length === 0, errors);

  await browser.close();
  console.log(`\nE2E 结果：${pass} 通过，${fail} 失败\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
