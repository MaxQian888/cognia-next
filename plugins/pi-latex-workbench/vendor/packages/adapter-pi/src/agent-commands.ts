import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getApprovedResource } from "@latexwb/core";
import type { WorkbenchSession } from "./session.ts";
import { handleLatexCommand } from "./latex-command.ts";

// Tasks are native prompt templates: Pi awaits their agent turn even in print
// mode. A fire-and-forget sendUserMessage from a command would exit too early.
const TASKS: Readonly<Record<string, string>> = {
  write: "Draft or extend a LaTeX document from a writing brief",
  revise: "Revise selected text; preserve unrelated content",
  tune: "Adjust typography, floats, spacing or a specific page",
  check: "Review source, compilation or layout without editing",
};

const HOST_COMMANDS: Readonly<Record<string, string>> = {
  doctor: "Probe the host toolchain",
  init: "Initialize an empty project from an approved template",
  build: "Compile a snapshot and target",
  repair: "Start the managed repair workflow",
  review: "Start the managed revision workflow (use check for read-only review)",
  bib: "Start the managed bibliography workflow",
  figure: "Start the managed data-assets workflow",
  migrate: "Start the managed template migration workflow",
  release: "Start the gated release workflow",
  status: "Show project, job or workflow status",
  cancel: "Cancel a job or managed workflow",
  pending: "List patches waiting for your approval",
  approve: "Approve a waiting patch (default: the newest) — host grant",
  mode: "Show or set protection mode: strict | authoring (new content auto-approved)",
  pdf: "Save the latest PDF to the exports folder (--open to view it)",
  sync: "Write the current sources back into the imported folder (journaled, conflict-safe)",
};

export function registerWorkbenchCommands(pi: ExtensionAPI, session: WorkbenchSession): void {
  const report = (value: unknown) => pi.sendMessage({
    customType: "latex-workbench",
    content: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    display: true,
  });
  const help = [
    "LaTeX workbench — ordinary writing also works in plain language.",
    ...Object.entries(TASKS).map(([name, description]) => `/latex-${name} <request> — ${description}`),
    "Host commands (flags, not natural-language requests):",
    ...Object.entries(HOST_COMMANDS).map(([name, description]) => `/latex-${name} — ${description}`),
    "Use /latex build --snapshot <id> --target <id> [--clean], /latex init --template <id> --target <id>,",
    "/latex status [job-or-workflow-id], /latex cancel <job-id> or --workflow <id>.",
    "Protected edits (equations, labels, citations, numbers): you are asked to approve in this UI;",
    "/latex pending lists waiting patches, /latex approve [patchId] grants one, /latex mode authoring",
    "auto-approves NEW protected content for this session (changes to existing content still ask).",
    "/latex pdf [--open] saves the latest PDF; /latex sync writes sources back to the imported folder.",
    "Managed workflows can pause for host input/approval; use the host CLI to resume them.",
    "Ordinary drafts finish with build artifacts; formal packaging requires /latex-release.",
  ].join("\n");

  const route = async (args: string, ctx: ExtensionCommandContext) => {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
    const name = match?.[1] ?? "help";
    if (name === "help") { report(help); return; }
    if (Object.hasOwn(TASKS, name)) {
      report(`Use /latex-${name} <request> to start the native Pi agent flow.`);
      return;
    }
    await handleLatexCommand(args, session, ctx, report);
  };

  // Keep validation at input; the successful path is expanded and awaited by
  // Pi itself, preserving attachments and native steering/follow-up behavior.
  pi.on("input", (event) => {
    const match = /^\/latex-(write|revise|tune|check)(?:\s+([\s\S]*))?$/.exec(event.text.trimStart());
    if (match !== null) {
      if (session.config.projectId === null || session.boundaryBroken) {
        report({ error: { code: "POLICY_DENIED", message: session.boundaryBroken
          ? `Controlled-session boundary is broken: ${session.boundaryBrokenReason}`
          : "Bind a dedicated Pi agent with LATEXWB_PROJECT and LATEXWB_STATE before using LaTeX commands." } });
        return { action: "handled" };
      }
      const request = match[2] ?? "";
      if (request.trim().length === 0) {
        report(`Usage: /latex-${match[1]} <request>. ${TASKS[match[1]!]}.`);
        return { action: "handled" };
      }
      // Pi's generic $@ expansion tokenizes quotes/whitespace. Preserve raw
      // LaTeX and multiline replacement text while retaining the awaited input
      // pipeline and native steering/follow-up semantics.
      try {
        const { content } = getApprovedResource({
          ctx: session.requestContextFor(["skill.resource.read"]),
          repoRoot: session.config.repoRoot,
          resourceId: `prompt:latex-${match[1]}`,
        });
        return { action: "transform", text: parseFrontmatter(content).body.replace("$@", () => request) };
      } catch (error) {
        report({ error: { message: error instanceof Error ? error.message : String(error) } });
        return { action: "handled" };
      }
    }
    return { action: "continue" };
  });
  pi.registerCommand("latex", {
    description: "LaTeX writing, revision, layout and host commands; /latex help",
    getArgumentCompletions: (prefix) => {
      const items = ["help", ...Object.keys(HOST_COMMANDS)]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: route,
  });
  for (const [name, description] of Object.entries({
    help: "Show LaTeX command help",
    ...HOST_COMMANDS,
  })) {
    pi.registerCommand(`latex-${name}`, {
      description,
      handler: (args, ctx) => route(`${name} ${args}`, ctx),
    });
  }
}
