import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ThresholdInput = string | number;
export interface Config {
  enabled: boolean;
  softAt: number;
  warnAt: number;
  buffer: number;
  hardCap: number;
}
export const DEFAULTS: Config = { enabled: true, softAt: 0.10, warnAt: 0.15, buffer: 0.10, hardCap: 0.90 };

export function parseThreshold(value: ThresholdInput, window: number): number {
  if (typeof value === "number") return value >= 1 ? value / window : value;
  const text = value.trim().toLowerCase();
  if (text.endsWith("%")) {
    const n = Number(text.slice(0, -1));
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid threshold: ${value}`);
    return n / 100;
  }
  const m = text.match(/^([\d.]+)\s*([km])?$/);
  if (!m) throw new Error(`invalid threshold: ${value}`);
  const n = Number(m[1]);
  const mult = m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1;
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid threshold: ${value}`);
  const tokens = n * mult;
  return tokens >= 1 ? tokens / window : tokens;
}

export function forcedAt(cfg: Config): number {
  return Math.min(cfg.warnAt + cfg.buffer, cfg.hardCap);
}

export type Phase = "ok" | "notice" | "warning" | "forced";
export function phaseFor(percent: number, cfg: Config): Phase {
  const p = percent / 100;
  if (p >= forcedAt(cfg)) return "forced";
  if (p >= cfg.warnAt) return "warning";
  if (p >= cfg.softAt) return "notice";
  return "ok";
}

/** 20-cell bar: `#` cached, `=` used, `-` free; `~` notice, `!` warning, `|` forced marker. */
export function contextBar(percent: number, phase: Phase, cachedPercent?: number): string {
  const cells = 20;
  const used = Math.max(0, Math.min(cells, Math.round(percent / 100 * cells)));
  const cached = Math.max(0, Math.min(used, Math.round((cachedPercent ?? 0) / 100 * cells)));
  let bar = "";
  for (let i = 0; i < cells; i++) bar += i < cached ? "#" : i < used ? "=" : "-";
  const mark = phase === "forced" ? "|" : phase === "warning" ? "!" : phase === "notice" ? "~" : " ";
  return `[${bar}] ${percent.toFixed(1)}% ${mark}${phase}`;
}

function readJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

export function loadConfig(agentDir: string, cwd: string, session: Record<string, unknown> = {}, window = 200_000): Config {
  const global = readJson(join(agentDir, "self-compact.json"));
  const project = readJson(join(cwd, ".omp", "self-compact.json"));
  const merged = { ...global, ...project, ...session } as Record<string, unknown>;
  const cfg = { ...DEFAULTS };
  if (typeof merged.enabled === "boolean") cfg.enabled = merged.enabled;
  if (merged.softAt !== undefined) cfg.softAt = parseThreshold(merged.softAt as ThresholdInput, window);
  if (merged.warnAt !== undefined) cfg.warnAt = parseThreshold(merged.warnAt as ThresholdInput, window);
  if (merged.buffer !== undefined) cfg.buffer = parseThreshold(merged.buffer as ThresholdInput, window);
  if (typeof merged.hardCap === "number" && merged.hardCap > 0 && merged.hardCap <= 1) cfg.hardCap = merged.hardCap;
  return cfg;
}

export function configPaths(agentDir: string, cwd: string): string[] {
  return [join(agentDir, "self-compact.json"), join(cwd, ".omp", "self-compact.json")];
}

export function readPrompt(cwd: string, agentDir: string, name: string, fallback: string): string {
  for (const dir of [join(cwd, ".omp", "self-compact"), join(agentDir, "self-compact")]) {
    const path = join(dir, name);
    if (existsSync(path)) {
      try { return readFileSync(path, "utf8"); } catch { /* keep fallback */ }
    }
  }
  return fallback;
}

export function render(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? `{{${key}}}`));
}
