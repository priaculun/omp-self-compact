import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { contextBar, DEFAULTS, forcedAt, loadConfig, parseThreshold, phaseFor } from "../src/config.ts";

describe("thresholds", () => {
  test("parses percent and token counts", () => {
    expect(parseThreshold("10%", 200_000)).toBeCloseTo(0.10);
    expect(parseThreshold("100k", 200_000)).toBeCloseTo(0.5);
    expect(parseThreshold(270_000, 1_000_000)).toBeCloseTo(0.27);
    expect(parseThreshold(0.15, 200_000)).toBeCloseTo(0.15);
  });
  test("forced is warning plus buffer capped at 90%", () => {
    expect(forcedAt(DEFAULTS)).toBeCloseTo(0.25);
    expect(forcedAt({ ...DEFAULTS, warnAt: 0.85, buffer: 0.10 })).toBeCloseTo(0.90);
  });
  test("phase order is ok, notice, warning, forced", () => {
    expect(phaseFor(5, DEFAULTS)).toBe("ok");
    expect(phaseFor(12, DEFAULTS)).toBe("notice");
    expect(phaseFor(20, DEFAULTS)).toBe("warning");
    expect(phaseFor(30, DEFAULTS)).toBe("forced");
  });
});

describe("context bar", () => {
  test("renders 20 cells with phase marker", () => {
    expect(contextBar(10, "notice")).toMatch(/^\[[#=\-]{20}\] 10\.0% ~notice$/);
    expect(contextBar(25, "forced")).toContain("|forced");
  });
});

describe("config overlays", () => {
  test("project wins over global", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-"));
    const agent = join(root, "agent"); const cwd = join(root, "cwd");
    mkdirSync(agent, { recursive: true }); mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(agent, "self-compact.json"), JSON.stringify({ enabled: true, warnAt: "15%" }));
    writeFileSync(join(cwd, ".omp", "self-compact.json"), JSON.stringify({ warnAt: "20%" }));
    const cfg = loadConfig(agent, cwd, {}, 200_000);
    expect(cfg.enabled).toBe(true);
    expect(cfg.warnAt).toBeCloseTo(0.20);
    expect(cfg.softAt).toBeCloseTo(0.10);
  });
});
