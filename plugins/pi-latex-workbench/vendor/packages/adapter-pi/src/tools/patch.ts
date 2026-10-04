/**
 * latex_patch — propose / apply / revert only.
 * Approvals are a host-channel operation (latexwb approve, or the operator's
 * answer to an in-session approval dialog): this tool must never expose an
 * approve action, and the contract's PatchInput has none. applyPatch still
 * enforces host grants for protected content internally.
 */
import {
  ERROR_CODES,
  WorkbenchError,
  type Diagnostic,
  type PatchApplicationResult,
  type PatchInput,
  type PatchProposal,
} from "@latexwb/contracts";
import {
  applyPatch,
  isAdditiveChange,
  loadTemplateRegistry,
  proposePatch,
  proposeRevert,
  type PatchApplyOutcome,
} from "@latexwb/core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { PatchParams } from "../schemas.ts";
import { requestOperatorApproval, summarizeProtected, type ApprovalUI } from "../approval.ts";
import { runTool, toAgentResult, type DispatchOutcome } from "./common.ts";

function info(code: string, message: string): Diagnostic {
  return {
    code,
    severity: "info",
    message,
    source: null,
    page: null,
    causeId: null,
    evidenceArtifactIds: [],
    rawLogRange: null,
    confidence: "certain",
  };
}

/** What apply will do with this proposal under the session's current mode. */
function proposalGuidance(session: WorkbenchSession, proposal: PatchProposal): Diagnostic[] {
  if (proposal.protectedChanges.length === 0) {
    return [info("PATCH_READY", "no protected changes — apply will not need a host approval")];
  }
  const mode = session.protectionMode();
  const additive = proposal.protectedChanges.every(isAdditiveChange);
  const outcome =
    mode === "authoring" && additive
      ? "authoring mode is on and every protected change is NEW content, so apply proceeds with an auto-recorded host grant"
      : `apply needs a host approval (protection mode: ${mode}${mode === "authoring" ? "; it covers additions only" : ""}); ` +
        "an interactive operator is asked automatically, otherwise the host grants it with `latexwb approve`";
  return [info("PROTECTED_CHANGES", `${summarizeProtected(proposal.protectedChanges)}. ${outcome}.`)];
}

/** Digests of approved-template files: pristine scaffolding, not user content. */
function scaffoldDigests(session: WorkbenchSession): Set<string> {
  return new Set(loadTemplateRegistry(session.config.repoRoot).flatMap((t) => t.files.map((f) => f.sha256)));
}

function appliedOutcome(outcome: PatchApplyOutcome): DispatchOutcome {
  const { authorization, approvalId, ...applied } = outcome;
  const data: PatchApplicationResult = applied;
  const diagnostics =
    authorization === "not-required"
      ? []
      : [info(
        "PATCH_AUTHORIZED",
        authorization === "authoring-mode"
          ? `protected additions authorized by host authoring mode (approval ${approvalId ?? "?"} recorded)`
          : `protected changes authorized by host approval ${approvalId ?? "?"}`,
      )];
  return { data, snapshotId: applied.snapshotId, diagnostics };
}

function isApprovalDenial(err: unknown): boolean {
  return err instanceof WorkbenchError && err.code === ERROR_CODES.POLICY_DENIED &&
    err.message.includes("requires a host approval");
}

async function dispatch(
  session: WorkbenchSession,
  input: PatchInput,
  scope: Scope,
  ui: ApprovalUI | null,
): Promise<DispatchOutcome> {
  const { store, blobs } = session;
  const ctx = session.requestContext();
  switch (input.action) {
    case "propose": {
      const proposal = proposePatch({
        store,
        blobs,
        ctx,
        scope,
        baseSnapshotId: input.baseSnapshotId,
        operations: input.operations,
        reason: input.reason,
        scaffoldSha256s: scaffoldDigests(session),
      });
      return { data: proposal, snapshotId: input.baseSnapshotId, diagnostics: proposalGuidance(session, proposal) };
    }
    case "apply": {
      const attempt = () =>
        applyPatch({ store, blobs, ctx, scope, patchId: input.patchId, protectionMode: session.protectionMode() });
      try {
        return appliedOutcome(attempt());
      } catch (err) {
        if (ui === null || !isApprovalDenial(err)) throw err;
        const decision = await requestOperatorApproval(session, scope, input.patchId, ui);
        if (decision === "denied") {
          throw new WorkbenchError(
            ERROR_CODES.POLICY_DENIED,
            `${(err as WorkbenchError).message}; the human operator declined the approval request — do not retry this patch unchanged`,
            { retryable: false },
          );
        }
        return appliedOutcome(attempt());
      }
    }
    case "revert": {
      // baseSnapshotId is the caller's claim about which snapshot the patch
      // produced; verify it before proposing the inverse so a stale caller
      // gets STALE_BASE rather than a confusing revert.
      const patch = store.getPatch(scope, input.patchId);
      if (patch === null) {
        throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `patch ${input.patchId} not found`);
      }
      if ((patch["result_snapshot_id"] as string | null) !== input.baseSnapshotId) {
        throw new WorkbenchError(
          ERROR_CODES.STALE_BASE,
          `patch ${input.patchId} produced snapshot ${patch["result_snapshot_id"]}, not ${input.baseSnapshotId}`,
        );
      }
      const reverted = proposeRevert({
        store,
        blobs,
        ctx,
        scope,
        patchId: input.patchId,
        reason: input.reason,
      });
      return { data: reverted, snapshotId: input.baseSnapshotId, diagnostics: proposalGuidance(session, reverted) };
    }
    default:
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `unsupported latex_patch action ${JSON.stringify((input as { action: string }).action)}; approvals stay on the host channel`,
      );
  }
}

/** Dialog UI when the session has one (TUI/RPC); null in print/JSON mode. */
export function approvalUi(ctx: ExtensionContext | undefined): ApprovalUI | null {
  if (ctx === undefined || !ctx.hasUI) return null;
  return {
    select: (title, options) => ctx.ui.select(title, options),
    editor: (title, prefill) => ctx.ui.editor(title, prefill),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
}

export function patchTool(session: WorkbenchSession): ToolDefinition {
  return {
    name: "latex_patch",
    label: "LaTeX Patch",
    description:
      "Propose, apply, or revert a patch against the bound project. " +
      "Prefer op 'replace' — {op:'replace', path, edits:[{oldText, newText}]}: oldText is copied " +
      "exactly from latex_project read output (including line breaks) and must occur exactly once " +
      "(add context or set occurrence otherwise). Op 'edit' takes UTF-8 byte ranges (startByte/endByte " +
      "from read lineByteOffsets or search byteOffset; endByte exclusive) plus expectedSha256. " +
      "Use 'create' for new files. Proposals are analysed for protected content (math, labels, " +
      "citations, reported numbers, quotes, unfamiliar commands); apply needs a host grant for " +
      "protected changes unless the host enabled authoring mode for new content. There is " +
      "deliberately no 'approve' action — grants are host-only. Inspect a proposal's diff via " +
      "latex_project artifact-read on its diffArtifactId.",
    promptSnippet: "Propose, apply or revert scoped source edits (exact-text replace or byte ranges) with host protection gates",
    promptGuidelines: [
      "latex_patch apply creates a new CAS snapshot; continue from that snapshot. It does not save into the host import directory.",
      "Prefer latex_patch op 'replace' with oldText copied verbatim from the latest read; keep each oldText short but unique. Preserve blank lines around the replaced text — they separate LaTeX paragraphs — and reread the applied region to verify.",
      "If apply returns POLICY_DENIED for protected changes, stop and report the patch id and the exact grant needed; never try to evade the gate by rewording math, removing labels or splitting protected content.",
    ],
    parameters: PatchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ui = approvalUi(ctx);
      const envelope = await runTool(session, "PatchInput", params, (input: PatchInput, scope) =>
        dispatch(session, input, scope, ui),
      );
      return toAgentResult(envelope);
    },
  };
}
