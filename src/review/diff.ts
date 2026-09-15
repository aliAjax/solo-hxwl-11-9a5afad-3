import type { EyeRx, Patient, RefractionRecord } from "./types";

export interface DiffCell {
  value: string;
  /** 与上一次记录相比的差值，如 -0.50D / +5° */
  delta?: string;
  /** 差异是否超过临床容差，需要复核关注 */
  alert?: boolean;
}

export interface DiffRow {
  label: string;
  cells: DiffCell[]; // 与 records 等长，第一列无 delta
}

const TOL_SPHERE = 0.5; // 球镜容差 D
const TOL_CYL = 0.5; // 柱镜容差 D
const TOL_AXIS = 10; // 轴位容差 °
const TOL_VISION = 0.1; // 矫正视力容差
const TOL_PD = 2; // 瞳距容差 mm

function fmtD(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

interface RowDef {
  label: string;
  get: (e: EyeRx) => number;
  fmt: (v: number) => string;
  fmtDelta: (d: number) => string;
  tol: number;
}

function eyeRows(eye: "OD" | "OS", records: RefractionRecord[]): DiffRow[] {
  const pick = (r: RefractionRecord): EyeRx => (eye === "OD" ? r.od : r.os);
  const defs: RowDef[] = [
    {
      label: `${eye} 球镜 DS`,
      get: (e) => e.sphere,
      fmt: fmtD,
      fmtDelta: (d) => `${d > 0 ? "+" : ""}${d.toFixed(2)}D`,
      tol: TOL_SPHERE,
    },
    {
      label: `${eye} 柱镜 DC`,
      get: (e) => e.cylinder,
      fmt: fmtD,
      fmtDelta: (d) => `${d > 0 ? "+" : ""}${d.toFixed(2)}D`,
      tol: TOL_CYL,
    },
    {
      label: `${eye} 轴位 AX`,
      get: (e) => e.axis,
      fmt: (v) => `${v}°`,
      fmtDelta: (d) => `${d > 0 ? "+" : ""}${d}°`,
      tol: TOL_AXIS,
    },
    {
      label: `${eye} 矫正视力`,
      get: (e) => Number(e.correctedVision),
      fmt: (v) => v.toFixed(1),
      fmtDelta: (d) => (d === 0 ? "±0" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`),
      tol: TOL_VISION,
    },
  ];

  return defs.map((def) => ({
    label: def.label,
    cells: records.map((r, i) => {
      const v = def.get(pick(r));
      if (i === 0) return { value: def.fmt(v) };
      const d = v - def.get(pick(records[i - 1]));
      return {
        value: def.fmt(v),
        delta: def.fmtDelta(d),
        alert: Math.abs(d) > def.tol,
      };
    }),
  }));
}

/** 生成双眼屈光对照行：OD/OS 各 4 行 + 瞳距 1 行 */
export function buildCompareRows(patient: Patient): {
  rows: DiffRow[];
  records: RefractionRecord[];
} {
  const records = [...patient.records].sort((a, b) => a.date.localeCompare(b.date));
  const pdRow: DiffRow = {
    label: "瞳距 PD",
    cells: records.map((r, i) => {
      const v = r.od.pd;
      if (i === 0) return { value: `${v}mm` };
      const d = v - records[i - 1].od.pd;
      return {
        value: `${v}mm`,
        delta: `${d > 0 ? "+" : ""}${d}mm`,
        alert: Math.abs(d) > TOL_PD,
      };
    }),
  };
  return { rows: [...eyeRows("OD", records), ...eyeRows("OS", records), pdRow], records };
}

/** 汇总超容差指标，供验光师一键标记冲突 */
export function detectAlerts(patient: Patient): { metric: string; detail: string }[] {
  const { rows, records } = buildCompareRows(patient);
  const out: { metric: string; detail: string }[] = [];
  for (const row of rows) {
    row.cells.forEach((cell, i) => {
      if (i > 0 && cell.alert) {
        out.push({
          metric: row.label,
          detail: `${records[i - 1].date} ${row.cells[i - 1].value} → ${records[i].date} ${cell.value}（变化 ${cell.delta}，超出复核容差）`,
        });
      }
    });
  }
  return out;
}
