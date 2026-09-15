import { useSyncExternalStore, useMemo, useState } from "react";
import "./styles.css";
import { MockServer } from "./review/server";
import { ReviewStore } from "./review/store";
import { buildCompareRows, detectAlerts } from "./review/diff";
import { can, denyReason } from "./review/rules";
import { PATIENTS, USERS } from "./review/seed";
import type {
  ActionType,
  AuditEntry,
  Conflict,
  Patient,
  ReviewItem,
  User,
} from "./review/types";
import { ROLE_LABEL, STATUS_LABEL } from "./review/types";

// 浏览器用 localStorage 持久化（模拟服务端库 + 客户端快照两份）
const browserKV: Storage = localStorage;
const server = new MockServer(browserKV, { latencyMs: 180 });
const store = new ReviewStore(server, browserKV);

function useStore() {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getView()
  );
}

let idSeq = 0;
function newActionId(): string {
  idSeq += 1;
  return `act-${Date.now().toString(36)}-${idSeq}-${Math.random().toString(36).slice(2, 6)}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_CLASS: Record<string, string> = {
  open: "st-open",
  pending_fix: "st-fix",
  escalated: "st-esc",
  confirmed: "st-ok",
};

const ACTION_LABEL: Record<ActionType, string> = {
  mark_conflict: "标记冲突",
  reopen_conflict: "重新开启冲突",
  close_conflict: "关闭冲突",
  to_pending_fix: "转待修正",
  to_escalated: "转需升级",
  confirm: "确认处方",
};

// ---------- 顶部：身份与网络 ----------

function TopBar({ user, setUser }: { user: User; setUser: (u: User) => void }) {
  const view = useStore();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">Rx</span>
        <div>
          <h1>验光处方复核台</h1>
          <p>同一患者多日期双眼屈光数据对照 · 冲突标记 · 复核流转与留痕</p>
        </div>
      </div>
      <div className="topbar-controls">
        <label className="role-switch">
          <span>当前身份</span>
          <select
            value={user.id}
            onChange={(e) => setUser(USERS.find((u) => u.id === e.target.value)!)}
          >
            {USERS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}（{ROLE_LABEL[u.role]}）
              </option>
            ))}
          </select>
        </label>
        <button
          className={view.online ? "net online" : "net offline"}
          onClick={() => store.setOnline(!view.online)}
          title="点击模拟断网/恢复"
        >
          <i />
          {view.online ? "在线" : "断网模拟中"}
          {view.outboxCount > 0 && <b>{view.outboxCount}</b>}
        </button>
        <button className="reset-btn" onClick={() => store.resetAll()} title="清空并恢复演示数据">
          重置演示
        </button>
      </div>
    </header>
  );
}

function Notice() {
  const view = useStore();
  if (!view.notice) return null;
  return (
    <div className={`notice ${view.notice.kind}`} onClick={() => store.clearNotice()}>
      {view.notice.text}
      <span className="notice-x">×</span>
    </div>
  );
}

// ---------- 指标概览 ----------

function MetricStrip() {
  const { state } = useStore();
  const openConflicts = state.items.reduce(
    (n, it) => n + it.conflicts.filter((c) => c.status === "open").length,
    0
  );
  const pending = state.items.filter((i) => i.status === "pending_fix").length;
  const escalated = state.items.filter((i) => i.status === "escalated").length;
  const confirmed = state.items.filter((i) => i.status === "confirmed").length;
  const cards = [
    { label: "待复核处方", value: state.items.length, tone: "st-open" },
    { label: "未关闭冲突", value: openConflicts, tone: "st-danger" },
    { label: "待修正 / 需升级", value: `${pending} / ${escalated}`, tone: "st-fix" },
    { label: "已确认", value: confirmed, tone: "st-ok" },
  ];
  return (
    <section className="metrics-grid">
      {cards.map((c) => (
        <article className="metric-card" key={c.label}>
          <span>{c.label}</span>
          <strong>{c.value}</strong>
          <i className={c.tone} />
        </article>
      ))}
    </section>
  );
}

// ---------- 双眼屈光对照表 ----------

function CompareTable({ patient }: { patient: Patient }) {
  const { rows, records } = useMemo(() => buildCompareRows(patient), [patient]);
  return (
    <div className="table-wrap">
      <table className="compare-table">
        <thead>
          <tr>
            <th>指标 / 日期</th>
            {records.map((r) => (
              <th key={r.id}>
                <strong>{r.date}</strong>
                <span>
                  {r.visitType} · {r.optometrist}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.label} className={ri === 4 ? "eye-sep" : undefined}>
              <td className="row-label">{row.label}</td>
              {row.cells.map((cell, i) => (
                <td key={i} className={cell.alert ? "cell-alert" : undefined}>
                  <span className="cell-value">{cell.value}</span>
                  {cell.delta && (
                    <span className={`delta ${cell.alert ? "delta-alert" : ""}`}>
                      {cell.delta}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {records.some((r) => r.note) && (
        <div className="rx-notes">
          {records.filter((r) => r.note).map((r) => (
            <p key={r.id}>
              <b>{r.date}</b>：{r.note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 冲突区 ----------

function ConflictCard({
  conflict,
  item,
  user,
}: {
  conflict: Conflict;
  item: ReviewItem;
  user: User;
}) {
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [note, setNote] = useState("");
  const open = conflict.status === "open";

  const closeDeny = open ? denyReason(item, "close_conflict", user.role) : null;
  const reopenDeny = !open ? denyReason(item, "reopen_conflict", user.role) : null;

  return (
    <article className={`conflict-card ${open ? "open" : "resolved"}`}>
      <div className="conflict-head">
        <strong>{conflict.metric}</strong>
        <span className={`conflict-flag ${open ? "flag-open" : "flag-resolved"}`}>
          {open ? "未关闭" : "已关闭"}
        </span>
      </div>
      <p className="conflict-detail">{conflict.detail}</p>
      <p className="conflict-meta">
        {conflict.markedByName}（{ROLE_LABEL[roleOf(conflict.markedBy)]}）
        标记于 {fmtTime(conflict.markedAt)}
        {conflict.resolvedByName &&
          ` · ${conflict.resolvedByName} 于 ${fmtTime(conflict.resolvedAt!)} 关闭`}
      </p>
      {open && can(user.role, "close_conflict") && item.status !== "confirmed" && (
        <div className="conflict-actions">
          {closing ? (
            <>
              <input
                placeholder="关闭依据，如：复查确认为真实度数变化"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="primary-action small"
                onClick={() => {
                  const at = new Date().toISOString();
                  store.dispatch(
                    {
                      actionId: newActionId(),
                      type: "close_conflict",
                      itemId: item.id,
                      actor: user,
                      at,
                      conflictId: conflict.id,
                      detail: note,
                    },
                    `close:${item.id}:${conflict.id}`
                  );
                  setClosing(false);
                  setNote("");
                }}
              >
                确认关闭
              </button>
              <button onClick={() => setClosing(false)}>取消</button>
            </>
          ) : (
            <button className="small" onClick={() => setClosing(true)}>
              关闭冲突
            </button>
          )}
        </div>
      )}
      {open && closeDeny && <p className="role-hint">{closeDeny}</p>}
      {!open && can(user.role, "reopen_conflict") && item.status !== "confirmed" && (
        <div className="conflict-actions">
          {reopening ? (
            <>
              <input
                placeholder="重新开启原因（可选），如：复查后数据仍矛盾"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="small tone-reopen"
                onClick={() => {
                  const at = new Date().toISOString();
                  store.dispatch(
                    {
                      actionId: newActionId(),
                      type: "reopen_conflict",
                      itemId: item.id,
                      actor: user,
                      at,
                      conflictId: conflict.id,
                      detail: note,
                    },
                    `reopen:${item.id}:${conflict.id}:${Date.now()}`
                  );
                  setReopening(false);
                  setNote("");
                }}
              >
                确认重新开启
              </button>
              <button onClick={() => setReopening(false)}>取消</button>
            </>
          ) : (
            <button className="small" onClick={() => setReopening(true)}>
              重新开启
            </button>
          )}
        </div>
      )}
      {!open && reopenDeny && <p className="role-hint">{reopenDeny}</p>}
    </article>
  );
}

function roleOf(userId: string): User["role"] {
  return USERS.find((u) => u.id === userId)?.role ?? "advisor";
}

function MarkConflictBox({ item, user }: { item: ReviewItem; user: User }) {
  const patient = PATIENTS.find((p) => p.id === item.patientId)!;
  const alerts = useMemo(() => detectAlerts(patient), [patient]);
  const [metric, setMetric] = useState("");
  const [detail, setDetail] = useState("");
  const disabled = !can(user.role, "mark_conflict") || item.status === "confirmed";

  return (
    <div className="mark-box">
      <div className="mark-title">标记处方冲突（验光师）</div>
      {alerts.length > 0 && (
        <div className="alert-suggest">
          {alerts.slice(0, 4).map((a) => {
            const used = item.conflicts.some(
              (c) => c.status === "open" && c.metric === a.metric && c.detail === a.detail
            );
            return (
              <button
                key={a.metric + a.detail}
                className="suggest-chip"
                disabled={disabled || used}
                title={a.detail}
                onClick={() => {
                  const at = new Date().toISOString();
                  store.dispatch(
                    {
                      actionId: newActionId(),
                      type: "mark_conflict",
                      itemId: item.id,
                      actor: user,
                      at,
                      metric: a.metric,
                      detail: a.detail,
                    },
                    `mark:${item.id}:${a.metric}:${a.detail.slice(0, 16)}`
                  );
                }}
              >
                ⚠ {a.metric} {used ? "（已标记）" : ""}
              </button>
            );
          })}
        </div>
      )}
      <div className="mark-form">
        <input
          placeholder="冲突指标（如：左眼球镜差异）"
          value={metric}
          disabled={disabled}
          onChange={(e) => setMetric(e.target.value)}
        />
        <input
          placeholder="冲突说明（日期、眼别、数值差异）"
          value={detail}
          disabled={disabled}
          onChange={(e) => setDetail(e.target.value)}
        />
        <button
          className="primary-action small"
          disabled={disabled || !metric.trim()}
          onClick={() => {
            const at = new Date().toISOString();
            store.dispatch(
              {
                actionId: newActionId(),
                type: "mark_conflict",
                itemId: item.id,
                actor: user,
                at,
                metric,
                detail,
              },
              `mark-manual:${item.id}:${metric.trim()}:${detail.trim().slice(0, 24)}`
            );
            setMetric("");
            setDetail("");
          }}
        >
          标记冲突
        </button>
      </div>
      {!can(user.role, "mark_conflict") && (
        <p className="role-hint">
          {user.role === "doctor"
            ? "复查医生可直接在下方流转；如需登记冲突可使用验光师账号"
            : "门店顾问为只读角色，不能标记冲突"}
        </p>
      )}
    </div>
  );
}

// ---------- 流转操作（仅复查医生） ----------

function FlowControls({ item, user }: { item: ReviewItem; user: User; }) {
  const [note, setNote] = useState("");
  const openConflicts = item.conflicts.filter((c) => c.status === "open").length;

  const Btn = ({ type, tone }: { type: ActionType; tone: string }) => {
    const reason = denyReason(item, type, user.role);
    return (
      <button
        className={`flow-btn ${tone}`}
        disabled={reason !== null}
        title={reason ?? ACTION_LABEL[type]}
        onClick={() => {
          const at = new Date().toISOString();
          store.dispatch(
            { actionId: newActionId(), type, itemId: item.id, actor: user, at, detail: note },
            `${type}:${item.id}`
          );
          setNote("");
        }}
      >
        {ACTION_LABEL[type]}
      </button>
    );
  };

  return (
    <div className="flow-box">
      <div className="mark-title">
        复核流转 <span className="doctor-only">仅复查医生可执行</span>
      </div>
      <div className="flow-guards">
        {openConflicts > 0 ? (
          <span className="guard bad">存在 {openConflicts} 条未关闭冲突 → 确认已锁定</span>
        ) : (
          <span className="guard ok">冲突已全部关闭，可确认</span>
        )}
        {item.status === "confirmed" && <span className="guard ok">处方已确认归档</span>}
      </div>
      <div className="flow-buttons">
        <Btn type="to_pending_fix" tone="tone-fix" />
        <Btn type="to_escalated" tone="tone-esc" />
        <Btn type="confirm" tone="tone-ok" />
      </div>
      <input
        placeholder="流转备注（可选）：修正要求 / 升级理由 / 确认意见"
        value={note}
        disabled={user.role !== "doctor" || item.status === "confirmed"}
        onChange={(e) => setNote(e.target.value)}
      />
      {user.role !== "doctor" && (
        <p className="role-hint">
          {user.role === "optometrist"
            ? "验光师只能标记冲突，不能确认或越级流转"
            : "门店顾问为只读角色"}
        </p>
      )}
    </div>
  );
}

// ---------- 处理记录（审计时间线） ----------

function AuditTimeline({ audit }: { audit: AuditEntry[] }) {
  return (
    <ol className="audit-list">
      {audit.map((a) => (
        <li key={a.id} className={`audit-item kind-${a.kind}`}>
          <div className="audit-dot" />
          <div className="audit-body">
            <div className="audit-line">
              <span className="audit-user">
                {a.userName}
                <em>{ROLE_LABEL[a.userRole]}</em>
              </span>
              <span className="audit-summary">{a.summary}</span>
            </div>
            <div className="audit-time">
              {fmtTime(a.at)}
              {a.pendingSync && <span className="pending-tag">待同步（断网暂存）</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------- 复核事项主面板 ----------

function ItemPanel({ item, user }: { item: ReviewItem; user: User }) {
  const patient = PATIENTS.find((p) => p.id === item.patientId)!;
  const openConflicts = item.conflicts.filter((c) => c.status === "open").length;

  return (
    <article className="panel item-panel">
      <div className="item-head">
        <div>
          <p className="eyebrow">
            {patient.id} · {patient.category} · {patient.records.length} 次验光记录
          </p>
          <h2>
            {patient.name}
            <span className={`status-badge ${STATUS_CLASS[item.status]}`}>
              {STATUS_LABEL[item.status]}
            </span>
            {openConflicts > 0 && <span className="conflict-count">{openConflicts} 条冲突未关闭</span>}
          </h2>
          <p className="rx-summary">{item.prescription}</p>
        </div>
      </div>

      <h3 className="block-title">① 多日期双眼屈光对照（差异超容差自动高亮）</h3>
      <CompareTable patient={patient} />

      <h3 className="block-title">② 处方冲突</h3>
      <div className="conflict-list">
        {item.conflicts.length === 0 && <p className="empty-hint">暂无冲突标记</p>}
        {item.conflicts.map((c) => (
          <ConflictCard key={c.id} conflict={c} item={item} user={user} />
        ))}
      </div>
      <MarkConflictBox item={item} user={user} />

      <h3 className="block-title">③ 复核流转</h3>
      <FlowControls item={item} user={user} />

      <h3 className="block-title">④ 处理记录（处理人 + 时间，每次决定均留痕）</h3>
      <AuditTimeline audit={item.audit} />
    </article>
  );
}

// ---------- 左侧事项列表 ----------

function ItemList({
  items,
  selectedId,
  onSelect,
}: {
  items: ReviewItem[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="item-list">
      {items.map((it) => {
        const patient = PATIENTS.find((p) => p.id === it.patientId)!;
        const open = it.conflicts.filter((c) => c.status === "open").length;
        const pending = it.audit.some((a) => a.pendingSync);
        return (
          <button
            key={it.id}
            className={`item-row ${it.id === selectedId ? "active" : ""}`}
            onClick={() => onSelect(it.id)}
          >
            <div className="item-row-top">
              <strong>{patient.name}</strong>
              <span className={`status-badge ${STATUS_CLASS[it.status]}`}>
                {STATUS_LABEL[it.status]}
              </span>
            </div>
            <div className="item-row-sub">
              <span>{patient.category}</span>
              <span>{patient.records.length} 次验光</span>
              {open > 0 && <span className="dot-danger">冲突 {open}</span>}
              {pending && <span className="dot-pending">待同步</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function App() {
  const view = useStore();
  const [user, setUser] = useState<User>(USERS[1]); // 默认验光师王验光
  const [selectedId, setSelectedId] = useState<string>(view.state.items[0]?.id ?? "");
  const item =
    view.state.items.find((i) => i.id === selectedId) ?? view.state.items[0];

  return (
    <main className="app-shell">
      <TopBar user={user} setUser={setUser} />
      <Notice />
      <MetricStrip />
      <section className="workspace">
        <aside className="panel narrow">
          <h2>复核队列（{view.state.items.length}）</h2>
          <ItemList
            items={view.state.items}
            selectedId={item?.id ?? ""}
            onSelect={setSelectedId}
          />
          <div className="rules-card">
            <h3>权限规则</h3>
            <ul>
              <li><b>验光师</b>：只能标记冲突</li>
              <li><b>复查医生</b>：关闭冲突、转待修正/需升级、确认</li>
              <li><b>门店顾问</b>：只读</li>
              <li>冲突未关闭不能确认；重复提交只生效一次</li>
              <li>断网操作暂存，恢复后自动同步并恢复留痕</li>
            </ul>
          </div>
        </aside>
        {item ? <ItemPanel item={item} user={user} /> : (
          <section className="panel"><p>暂无复核事项</p></section>
        )}
      </section>
      <footer className="foot">
        hxwl-11 眼科验光记录 · 验光处方复核台 · React + Vite + TypeScript
      </footer>
    </main>
  );
}

export default App;
