// The builder agent: Claude (via the Agent SDK) edits one app directory under strict permissions.
// MockBuilder is a deterministic stand-in for dry runs and tests (no API calls).
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "./config.js";
import { paths } from "./config.js";
import { log } from "./exec.js";
import { formatPrice, type Idea } from "./ideas.js";

export type BuildMode = "build" | "repair" | "iterate";

export interface BuildTask {
  dir: string;
  idea: Idea;
  mode: BuildMode;
  /** Mode-specific prompt variables ({{FAILURES}}, {{SCORECARD}}, ...). */
  vars?: Record<string, string>;
}

export interface BuildOutcome {
  ok: boolean;
  costUsd: number;
  summary: string;
}

export interface Builder {
  run(task: BuildTask): Promise<BuildOutcome>;
}

export function renderPrompt(mode: BuildMode, vars: Record<string, string>) {
  let text = readFileSync(join(paths.prompts, `${mode}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return text;
}


const ALLOWED_BASH = [
  /^npm (run )?(typecheck|test)( --.*)?$/,
  /^npx (tsc --noEmit|vitest run)( [\w./ -]*)?$/,
  /^node build\.mjs$/,
  /^(ls|cat|head|tail|wc|grep|find) [^;&|`$<>]*$/,
];

/** Returns true if `target` is inside the app-owned area of `dir`. */
export function isWritable(dir: string, target: string) {
  const abs = isAbsolute(target) ? target : resolve(dir, target);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return rel.startsWith("src/app/") || /^tests\/app[\w.-]*\.test\.ts$/.test(rel);
}

export function makePermissionPolicy(dir: string): CanUseTool {
  return async (toolName, input) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const allow = () => ({ behavior: "allow" as const, updatedInput: input });
    switch (toolName) {
      case "Read":
      case "Glob":
      case "Grep": {
        const p = (input.file_path ?? input.path) as string | undefined;
        if (p && relative(dir, resolve(dir, p)).startsWith("..")) return deny("Stay inside the app directory.");
        return allow();
      }
      case "Write":
      case "Edit":
      case "MultiEdit": {
        const p = String(input.file_path ?? "");
        return isWritable(dir, p) ? allow() : deny(`Only src/app/** and tests/app*.test.ts may be modified (tried ${p}).`);
      }
      case "Bash": {
        const cmd = String(input.command ?? "").trim();
        return ALLOWED_BASH.some((re) => re.test(cmd))
          ? allow()
          : deny("Allowed commands: npm run typecheck, npm test, npx tsc --noEmit, npx vitest run, node build.mjs, and read-only ls/cat/grep/find.");
      }
      case "TodoWrite":
        return allow();
      default:
        return deny(`${toolName} is not available to the builder.`);
    }
  };
}

export class ClaudeBuilder implements Builder {
  constructor(private cfg: Config) {}

  async run(task: BuildTask): Promise<BuildOutcome> {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN)
      throw new Error("ANTHROPIC_API_KEY is not set (or use --dry-run)");
    const prompt = renderPrompt(task.mode, { PRICE: formatPrice(task.idea), ...task.vars });
    const rules = readFileSync(join(paths.prompts, "rules.md"), "utf8");
    let costUsd = 0;
    let summary = "";
    let ok = false;
    const q = query({
      prompt,
      options: {
        cwd: task.dir,
        model: this.cfg.builder.model,
        maxTurns: this.cfg.builder.maxTurns,
        maxBudgetUsd: this.cfg.builder.maxBudgetUsdPerBuild,
        permissionMode: "default",
        canUseTool: makePermissionPolicy(task.dir),
        settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code", append: rules },
      },
    });
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            const inp = block.input as Record<string, unknown>;
            log(`  agent → ${block.name} ${String(inp.file_path ?? inp.command ?? inp.pattern ?? "").slice(0, 100)}`);
          }
        }
      } else if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        ok = msg.subtype === "success" && !msg.is_error;
        summary = msg.subtype === "success" ? msg.result : `agent stopped: ${msg.subtype}`;
      }
    }
    return { ok, costUsd, summary };
  }
}

/**
 * Dry-run builder: renames the placeholder app's activation event and title to the idea's,
 * which is enough to exercise every gate and the deploy pipeline without calling a model.
 */
export class MockBuilder implements Builder {
  async run(task: BuildTask): Promise<BuildOutcome> {
    const ev = task.idea.activationEvent;
    const edit = (rel: string, fn: (s: string) => string) => {
      const f = join(task.dir, rel);
      writeFileSync(f, fn(readFileSync(f, "utf8")));
    };
    edit("src/app/routes.ts", (s) => s.replaceAll('"note_created"', `"${ev}"`));
    edit("src/app/manifest.ts", (s) => s.replace(/activationEvent: "[^"]+"/, `activationEvent: "${ev}"`));
    edit("src/app/web/index.html", (s) =>
      s.replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${task.idea.pitch.replaceAll('"', "'")}"`),
    );
    return { ok: true, costUsd: 0, summary: `[mock ${task.mode}] placeholder app adapted for ${task.idea.slug}` };
  }
}
