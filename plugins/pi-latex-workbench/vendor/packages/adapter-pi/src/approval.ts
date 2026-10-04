/**
 * Human-in-the-loop approval inside a Pi session (ADR-0007).
 *
 * The model can never approve its own patch: latex_patch has no approve
 * action and nothing here reads identity or consent from tool parameters.
 * When a protected apply is blocked and the session has dialog-capable UI
 * (interactive TUI, or an RPC host that answers extension dialogs), the
 * operator at that UI is asked directly — the same trust as running
 * `latexwb approve` in a terminal. The resulting grant is an ordinary
 * patch-digest-bound approval row, attributed to the host principal with
 * `grantedVia: "pi-ui"`. Print/JSON mode has no UI: the POLICY_DENIED stands
 * and the host CLI remains the grant channel.
 */
import type { ProtectedChange } from "@latexwb/contracts";
import { grantApproval, isAdditiveChange } from "@latexwb/core";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "./session.ts";

/** The subset of Pi's ExtensionUIContext the approval dialog needs. */
export interface ApprovalUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export type ApprovalDecision = "approved" | "approved-authoring" | "denied";

const APPROVE = "Approve this patch";
const APPROVE_AUTHORING = "Approve, and auto-approve NEW protected content for this session (authoring mode)";
const SHOW_DIFF = "Show the diff first";
const DENY = "Deny";

/** "math×3, label×1" — counts per category for one change kind. */
function tally(changes: ProtectedChange[]): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(", ") || "none";
}

/** One-paragraph summary of a proposal's protected changes. */
export function summarizeProtected(changes: ProtectedChange[]): string {
  const additions = changes.filter(isAdditiveChange);
  const others = changes.filter((c) => !isAdditiveChange(c));
  return `${changes.length} protected change(s) — new: ${tally(additions)}; modified/removed: ${tally(others)}`;
}

function diffText(session: WorkbenchSession, diffArtifactId: string | undefined): string {
  if (diffArtifactId === undefined || !/^diff-[a-f0-9]{64}$/.test(diffArtifactId)) return "(diff unavailable)";
  try {
    return new TextDecoder().decode(session.blobs.getVerified(diffArtifactId.slice(5)));
  } catch {
    return "(diff unavailable)";
  }
}

/**
 * Ask the operator to approve a waiting patch. On approval, record the
 * grant (and, when chosen, switch the session to authoring mode). Returns
 * the decision; the caller retries apply after an approval.
 */
export async function requestOperatorApproval(
  session: WorkbenchSession,
  scope: Scope,
  patchId: string,
  ui: ApprovalUI,
): Promise<ApprovalDecision> {
  const row = session.store.getPatch(scope, patchId);
  if (row === null) return "denied";
  const changes = JSON.parse(row["protected_changes_json"] as string) as ProtectedChange[];
  const ops = JSON.parse(row["operations_json"] as string) as {
    reason?: string;
    operations?: { path?: string }[];
    diffArtifactId?: string;
  };
  const paths = [...new Set((ops.operations ?? []).map((o) => o.path).filter((p) => p !== undefined))];
  // Most informative first: modifications/removals before additions, then
  // the longest content (a display equation beats a one-letter `$i$`);
  // identical entries collapse into one line.
  const seen = new Set<string>();
  const ranked = [...changes]
    .sort((a, b) =>
      Number(isAdditiveChange(a)) - Number(isAdditiveChange(b)) ||
      (b.after.length + b.before.length) - (a.after.length + a.before.length))
    .filter((c) => {
      const key = `${c.change ?? ""}|${c.category}|${c.before}|${c.after}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 70);
  const examples = ranked
    .slice(0, 6)
    .map((c) => `  • ${c.change ?? "changed"} ${c.category}: ${c.reason}` +
      `${c.before ? ` | before: ${oneLine(c.before)}` : ""}${c.after ? ` | after: ${oneLine(c.after)}` : ""}`);
  const title = [
    `LaTeX workbench — the agent asks to apply a protected edit (project ${scope.projectId})`,
    `patch ${patchId}`,
    `reason: ${(ops.reason ?? "").slice(0, 200)}`,
    `files: ${paths.join(", ") || "?"}`,
    summarizeProtected(changes),
    ...examples,
    ...(ranked.length > examples.length ? [`  … ${changes.length - examples.length} more`] : []),
  ].join("\n");

  for (;;) {
    const choice = await ui.select(title, [APPROVE, APPROVE_AUTHORING, SHOW_DIFF, DENY]);
    if (choice === SHOW_DIFF) {
      await ui.editor(`Diff for ${patchId} (read-only; close to return)`, diffText(session, ops.diffArtifactId));
      continue;
    }
    if (choice !== APPROVE && choice !== APPROVE_AUTHORING) return "denied";
    grantApproval({
      store: session.store,
      scope,
      hostPrincipal: session.config.principalId,
      action: "patch.apply",
      scopeDigest: row["patch_digest"] as string,
      baseSnapshotId: row["base_snapshot_id"] as string,
      policyId: session.config.policyId,
      expiresInSeconds: 600,
      grantedVia: "pi-ui",
    });
    if (choice === APPROVE_AUTHORING) {
      session.protectionOverride = "authoring";
      ui.notify("latexwb: authoring mode on for this session — new equations/labels/citations apply without a prompt; edits to existing protected content still ask.", "info");
      return "approved-authoring";
    }
    return "approved";
  }
}
