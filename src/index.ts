import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { configPaths, contextBar, forcedAt, loadConfig, phaseFor, readPrompt, render, type Config } from "./config.ts";

const NOTE = "omp-self-compact:note";
const OPTIONS = "omp-self-compact:options";
const HANDOFF = "omp-self-compact:handoff";

const SOFT_FALLBACK = "Context {{used_percent}}% ({{used_tokens}}/{{window_tokens}}). Keep working; no action needed yet. When you finish a subtask, write state so a later compact can resume.";
const WARN_FALLBACK = "Context {{used_percent}}% (soft {{soft_percent}}%, forced {{forced_percent}}%). Wrap up the current step and call self_compact with a handoff note soon.";
const COMPACT_FALLBACK = "Summarize this session for continuation. Preserve: current goal, completed steps, open work, key decisions, file paths, and the handoff note verbatim. Note: {{note}}";

interface BranchEntry { type: string; customType?: string; data?: unknown; }

export default function selfCompact(omp: ExtensionAPI) {
  const agentDir = omp.pi.getAgentDir();
  const z = omp.zod;
  const optionSchema = z.object({
    enabled: z.boolean().optional(),
    softAt: z.union([z.string(), z.number()]).optional(),
    warnAt: z.union([z.string(), z.number()]).optional(),
    buffer: z.union([z.string(), z.number()]).optional(),
  });
  const noteSchema = z.object({ note: z.string().optional(), at: z.number().optional(), reason: z.string().optional() });
  function optionsOf(entry: BranchEntry): Record<string, unknown> | undefined {
    if (entry.type !== "custom" || entry.customType !== OPTIONS) return undefined;
    if (!entry.data || typeof entry.data !== "object") return undefined;
    const parsed = optionSchema.safeParse(entry.data);
    if (!parsed.success) return undefined;
    return parsed.data;
  }
  let options: Record<string, unknown> = {};
  let note = "";
  let lastInfo = "Belum ada evaluasi konteks.";
  let announced = new Set<string>();

  function cfg(ctx: ExtensionContext): Config {
    const usage = ctx.getContextUsage();
    return loadConfig(agentDir, ctx.cwd, options, usage?.contextWindow ?? 200_000);
  }
  function snapshot(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;
    const c = cfg(ctx);
    const phase = phaseFor(usage.percent, c);
    return { usage, config: c, phase, forced: forcedAt(c) };
  }
  function refresh(ctx: ExtensionContext): void {
    const snap = snapshot(ctx);
    if (!snap) { ctx.ui.setStatus("self-compact", undefined); return; }
    const text = `${contextBar(snap.usage.percent, snap.phase)}${note ? " · note✓" : ""}`;
    ctx.ui.setStatus("self-compact", cfg(ctx).enabled ? text : undefined);
    lastInfo = `${text}\ntokens=${snap.usage.tokens} window=${snap.usage.contextWindow}\nnote=${note ? `${note.length} chars` : "none"}`;
  }
  function noteOf(entry: BranchEntry): string | undefined {
    if (entry.type !== "custom" || entry.data === null || typeof entry.data !== "object") return undefined;
    const parsed = noteSchema.safeParse(entry.data);
    if (!parsed.success || typeof parsed.data.note !== "string") return undefined;
    return parsed.data.note;
  }
  function guidance(ctx: ExtensionContext, kind: "soft" | "warning"): string {
    const snap = snapshot(ctx);
    const usage = snap?.usage ?? { tokens: 0, percent: 0, contextWindow: 0 };
    const c = snap?.config ?? cfg(ctx);
    const values = {
      used_tokens: usage.tokens, used_percent: usage.percent.toFixed(1),
      window_tokens: usage.contextWindow, soft_percent: (c.softAt * 100).toFixed(1),
      warning_percent: (c.warnAt * 100).toFixed(1), forced_percent: (forcedAt(c) * 100).toFixed(1),
      warning_tokens: Math.round(c.warnAt * usage.contextWindow),
    };
    const fallback = kind === "soft" ? SOFT_FALLBACK : WARN_FALLBACK;
    return render(readPrompt(ctx.cwd, agentDir, kind === "soft"
      ? "USER_PROMPT_SOFT_SELF_COMPACT.md" : "USER_PROMPT_WARNING_SELF_COMPACT.md", fallback), values);
  }

  async function handoff(ctx: ExtensionContext | ExtensionCommandContext, reason: string): Promise<string> {
    if (!note.trim()) return "Isi self_compact dengan note_to_self dulu — compaction tanpa note akan kehilangan state kerja.";
    omp.appendEntry(NOTE, structuredClone({ note, at: Date.now(), reason }));
    const template = readPrompt(ctx.cwd, agentDir, "USER_PROMPT_COMPACTION_MESSAGE.md", COMPACT_FALLBACK);
    const instructions = render(template, { note });
    announced.clear();
    await ctx.compact({ internalGuidance: instructions, suppressContinuation: false });
    return `Compaction diminta (${reason}). Note ${note.length} karakter diteruskan ke ringkasan.`;
  }

  function restore(ctx: ExtensionContext) {
    options = {}; note = ""; announced = new Set();
    if (ctx.agent.kind !== "main") return;
    for (const entry of ctx.sessionManager.getBranch() as BranchEntry[]) {
      const o = optionsOf(entry);
      if (o) options = o;
      if (entry.customType === NOTE || entry.customType === HANDOFF) {
        const n = noteOf(entry);
        if (typeof n !== "string") continue;
        if (entry.customType === NOTE) {
          note = n;
        } else if (n) {
          note = "";
          ctx.ui.notify(`Handoff dari compaction sebelumnya:\n\n${n}`, "info");
        }
      }
    }
    refresh(ctx);
  }

  omp.on("turn_end", (_e, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const c = cfg(ctx);
    if (!c.enabled) return;
    const snap = snapshot(ctx);
    if (!snap) return;
    const key = `${snap.phase}:${Math.floor(snap.usage.percent)}`;
    if (snap.phase === "notice" && !announced.has(key)) {
      announced.add(key);
      omp.sendMessage({ customType: "self-compact-notice", data: { text: guidance(ctx, "soft") }, display: false }, { deliverAs: "nextTurn" });
    } else if (snap.phase === "warning" && !announced.has(key)) {
      announced.add(key);
      omp.sendMessage({ customType: "self-compact-warning", data: { text: guidance(ctx, "warning") }, display: false }, { deliverAs: "nextTurn" });
    }
    refresh(ctx);
  });

  omp.on("tool_call", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const c = cfg(ctx);
    if (!c.enabled) return;
    const snap = snapshot(ctx);
    if (!snap || snap.phase !== "forced") return;
    if (event.toolName === "self_compact" || event.toolName === "view_context") return;
    return {
      block: true,
      reason: `Context ${snap.usage.percent.toFixed(1)}% ≥ forced ${(snap.forced * 100).toFixed(1)}%. Panggil self_compact({ note_to_self }) dulu, atau /compact manual.`,
    };
  });

  omp.registerTool({
    name: "self_compact",
    label: "Self compact",
    description: "Save a handoff note and compact this session. Call when context crosses warning/forced thresholds.",
    parameters: z.object({ note_to_self: z.string().min(1).describe("Handoff state for resume after compaction") }),
    approval: "read",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      note = params.note_to_self;
      omp.appendEntry(NOTE, structuredClone({ note, at: Date.now(), reason: "tool" }));
      refresh(ctx);
      return { content: [{ type: "text", text: await handoff(ctx, "self_compact") }], details: { noteLength: note.length } };
    },
  });

  omp.registerTool({
    name: "view_context",
    label: "View context",
    description: "Current context usage numbers as JSON.",
    parameters: z.object({}),
    approval: "read",
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const snap = snapshot(ctx);
      const payload = snap
        ? { tokens: snap.usage.tokens, percent: snap.usage.percent, window: snap.usage.contextWindow,
            phase: snap.phase, softAt: snap.config.softAt, warnAt: snap.config.warnAt,
            forcedAt: snap.forced, hardCap: snap.config.hardCap, noteChars: note.length }
        : { error: "context usage unavailable" };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    },
  });

  omp.registerCommand("self-compact-info", {
    description: "Show self-compact thresholds and state",
    handler: async (_args, ctx) => {
      const c = cfg(ctx);
      const snap = snapshot(ctx);
      ctx.ui.notify(`enabled=${c.enabled}\nsoft=${(c.softAt * 100).toFixed(1)}% warn=${(c.warnAt * 100).toFixed(1)}% buffer=${(c.buffer * 100).toFixed(1)}% forced=${(forcedAt(c) * 100).toFixed(1)}% cap=${(c.hardCap * 100).toFixed(0)}%\n`
        + `config: ${configPaths(agentDir, ctx.cwd).join(" → ")}\nusage=${snap ? `${snap.usage.tokens}/${snap.usage.contextWindow} (${snap.usage.percent.toFixed(1)}%, ${snap.phase})` : "unknown"}\n${lastInfo}`, "info");
    },
  });
  omp.registerCommand("self-compact-now", {
    description: "Force the self-compact handoff cycle immediately",
    handler: async (_args, ctx) => {
      const message = await handoff(ctx, "command");
      ctx.ui.notify(message, "info");
    },
  });
  omp.registerCommand("self-compact-on", {
    description: "Enable self-compact for this session",
    handler: async (_args, ctx) => {
      options = { ...options, enabled: true };
      omp.appendEntry(OPTIONS, structuredClone(options));
      refresh(ctx);
      ctx.ui.notify("self-compact aktif untuk session ini.", "info");
    },
  });
  omp.registerCommand("self-compact-off", {
    description: "Disable self-compact for this session",
    handler: async (_args, ctx) => {
      options = { ...options, enabled: false };
      omp.appendEntry(OPTIONS, structuredClone(options));
      refresh(ctx);
      ctx.ui.notify("self-compact nonaktif untuk session ini.", "info");
    },
  });
}
