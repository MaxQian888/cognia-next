/**
 * Controlled-session enforcement for Pi 0.85.1.
 *
 * These are the security deliverable, not prompt text:
 *  - session_start restricts the active tool set to exactly the eight
 *    latex_* tools and READS BACK getActiveTools() to verify. If host tools
 *    are still active the boundary is declared broken: session.boundaryBroken
 *    is set (every tool call then fails loudly) and the operator is notified.
 *  - project_trust answers "no" so an untrusted project cannot load local
 *    extensions, rc files or settings.
 *  - resources_discover advertises only repository-owned skill paths.
 *  - tool_call is defense in depth: anything outside the allowlist is
 *    blocked even if something re-enabled it.
 *  - user_bash denies shell execution.
 *
 * Each handler returns its real Pi result value; tests assert those values.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ProjectTrustEventResult,
  ToolCallEventResult,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

/** Not re-exported from the pi package root in 0.85.1; this is the exact shape. */
export interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}
import type { WorkbenchSession } from "./session.ts";
import { adaptBasePrompt, workbenchAgentContext, workbenchStatusLine } from "./agent-context.ts";

export const LATEXWB_TOOL_NAMES = [
  "latex_project",
  "latex_patch",
  "latex_build",
  "latex_check",
  "latex_render",
  "latex_bib",
  "latex_figure",
  "latex_export",
] as const;

const ALLOWED = new Set<string>(LATEXWB_TOOL_NAMES);

/** Host-side tools that must be absent from the read-back. */
const HOST_TOOL_NAMES = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "powershell",
  "ls",
] as const;

export interface SessionStartVerification {
  /** Verbatim result of getActiveTools() after setActiveTools. */
  activeTools: string[];
  /** Allowlist violations found in the read-back (host or unknown tools). */
  violations: string[];
  enforced: boolean;
}

/**
 * session_start: restrict to the eight tools, then verify the read-back.
 * Returns the verification record (the pi handler ignores the return value).
 */
export function verifyActiveTools(
  pi: Pick<ExtensionAPI, "setActiveTools" | "getActiveTools">,
  session: WorkbenchSession,
  notify?: (message: string) => void,
): SessionStartVerification {
  pi.setActiveTools([...LATEXWB_TOOL_NAMES]);
  const activeTools = pi.getActiveTools();
  const violations = activeTools.filter((name) => !ALLOWED.has(name));
  const hostTools = violations.filter((name) =>
    (HOST_TOOL_NAMES as readonly string[]).includes(name),
  );
  const enforced = violations.length === 0;
  if (!enforced) {
    session.boundaryBroken = true;
    session.boundaryBrokenReason =
      `getActiveTools() after setActiveTools still reports non-allowlisted tools ` +
      `[${violations.join(", ")}]` +
      (hostTools.length > 0 ? ` (host tools: ${hostTools.join(", ")})` : "");
    notify?.(
      `latexwb: controlled-session boundary NOT enforceable — ${session.boundaryBrokenReason}. Tool calls will fail closed.`,
    );
  }
  return { activeTools, violations, enforced };
}

/** project_trust: never trust — the project must not load local config. */
export function projectTrustResult(): ProjectTrustEventResult {
  return { trusted: "no" };
}

/** resources_discover: only repository-owned, deterministic resources. */
export function resourcesDiscoverResult(repoRoot: string): ResourcesDiscoverResult {
  const skillsDir = join(repoRoot, "resources", "skills");
  const promptsDir = join(repoRoot, "resources", "prompts");
  const skillPaths = existsSync(skillsDir)
    ? readdirSync(skillsDir)
      .filter((name) => statSync(join(skillsDir, name)).isDirectory())
      .sort()
      .map((name) => join(skillsDir, name))
    : [];
  const promptPaths = existsSync(promptsDir)
    ? readdirSync(promptsDir)
      .filter((name) => name !== "base-system.md" && name.endsWith(".md") && statSync(join(promptsDir, name)).isFile())
      .sort()
      .map((name) => join(promptsDir, name))
    : [];
  return { skillPaths, promptPaths, themePaths: [] };
}

/** tool_call: allow only the eight latex_* tools. */
export function toolCallResult(toolName: string): ToolCallEventResult {
  if (ALLOWED.has(toolName)) {
    return { block: false };
  }
  return {
    block: true,
    reason: `tool ${JSON.stringify(toolName)} is not allowed in the latexwb controlled session; only the eight latex_* tools are`,
  };
}

/** user_bash: deny shell execution with a real BashResult-shaped refusal. */
export function userBashResult(command: string): UserBashEventResult {
  return {
    result: {
      output:
        `latexwb: shell execution is denied in the controlled session ` +
        `(refused command: ${JSON.stringify(command)})`,
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  };
}

export function registerSessionControl(pi: ExtensionAPI, session: WorkbenchSession): void {
  if (session.config.projectId === null) {
    // Unbound install: the eight tools are registered but deny work
    // individually (assertBound → POLICY_DENIED). We deliberately do NOT
    // restrict the host toolset, bash, trust flow, or resources here — a
    // plugin must not hijack an ordinary pi session just because it is
    // installed. Binding is host-owned via LATEXWB_PROJECT.
    pi.on("session_start", () => {
      process.stderr.write(
        "latexwb: LATEXWB_PROJECT unset — session unbound; latex_* tool calls will be denied.\n",
      );
    });
    return;
  }
  // Footer status in dialog-capable sessions; refreshed after every turn so
  // applies, builds and pending approvals show up without asking.
  const refreshStatus = (ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } }) => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus("latexwb", workbenchStatusLine(session));
    } catch {
      // Status is cosmetic; never let it break the session.
    }
  };
  pi.on("session_start", (_event, ctx) => {
    const v = verifyActiveTools(pi, session, (msg) => {
      try {
        ctx.ui.notify(msg, "error");
      } catch {
        process.stderr.write(`${msg}\n`);
      }
    });
    // Evidence line for the controlled-session boundary (stderr so print-mode
    // transcripts capture it verbatim).
    process.stderr.write(
      `latexwb: session_start active tools read-back: ${JSON.stringify(v.activeTools)} ` +
        `(${v.enforced ? "enforced" : "NOT ENFORCED — see UNSUPPORTED.md"})\n`,
    );
    refreshStatus(ctx);
  });
  pi.on("turn_end", (_event, ctx) => refreshStatus(ctx));
  pi.on("project_trust", () => projectTrustResult());
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${adaptBasePrompt(event.systemPrompt)}\n\n${workbenchAgentContext(session)}`,
  }));
  pi.on("resources_discover", () => resourcesDiscoverResult(session.config.repoRoot));
  pi.on("tool_call", (event) => toolCallResult(event.toolName));
  pi.on("user_bash", (event) => userBashResult(event.command));
}
