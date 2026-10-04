/**
 * Shared tool-call plumbing: contract-first validation, session project
 * binding, envelope wrapping. TypeBox schemas are LLM hints only — the
 * frozen JSON-Schema validator runs here inside every execute().
 */
import {
  ERROR_CODES,
  WorkbenchError,
  formatErrors,
  validatorFor,
  type ToolData,
  type ToolEnvelope,
} from "@latexwb/contracts";
import type { ArtifactRef } from "@latexwb/contracts";
import type { Scope, WorkbenchStore } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { buildEnvelope, failureEnvelope, makeRequestId, sanitizeForModel } from "../envelope.ts";

/** A real image block for the Pi content array (base64-encoded at emit). */
export interface AttachedImage {
  data: Uint8Array;
  mimeType: string;
}

export interface DispatchOutcome {
  data: ToolData | null;
  snapshotId: string | null;
  execution?: ToolEnvelope["execution"];
  /** Required when execution === "blocked": names the missing surface. */
  blockedMessage?: string;
  artifacts?: ToolEnvelope["artifacts"];
  diagnostics?: ToolEnvelope["diagnostics"];
}

export function blocked(snapshotId: string | null, message: string): DispatchOutcome {
  return { data: null, snapshotId, execution: "blocked", blockedMessage: message };
}

/** Artifact rows of a job as contract ArtifactRef values. */
export function jobArtifactRefs(
  store: WorkbenchStore,
  scope: Scope,
  jobId: string,
): ArtifactRef[] {
  return store.listArtifactsByJob(scope, jobId).map((a) => ({
    id: a["artifact_id"] as string,
    projectId: scope.projectId,
    snapshotId: a["snapshot_id"] as string,
    targetId: (a["target_id"] as string | null) ?? null,
    jobId: a["job_id"] as string,
    kind: a["kind"] as ArtifactRef["kind"],
    sha256: a["blob_hash"] as string,
    bytes: a["size_bytes"] as number,
    mediaType: a["media_type"] as string,
    createdAt: a["created_at"] as string,
  }));
}

/**
 * Pi AgentToolResult wrapper: the validated envelope is ALWAYS the first
 * text block — after recursive terminal-hygiene sanitation (SECURITY-11).
 * Real image bytes may follow as Pi image blocks (latex_render pages);
 * they are never inlined into the envelope JSON itself.
 */
export function toAgentResult(envelope: ToolEnvelope, images: AttachedImage[] = []) {
  const clean = sanitizeForModel(envelope) as ToolEnvelope;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(clean) },
      ...images.map((img) => ({
        type: "image" as const,
        data: Buffer.from(img.data).toString("base64"),
        mimeType: img.mimeType,
      })),
    ],
    details: {},
  };
}

/**
 * One tool call, end to end:
 *   boundary check → frozen-schema validation → project binding → dispatch
 *   → schema-validated ToolEnvelope.
 * Any thrown value becomes a structured error envelope; nothing unstructured
 * escapes to the model.
 */
export async function runTool(
  session: WorkbenchSession,
  inputDef: string,
  params: unknown,
  dispatch: (input: never, scope: Scope) => DispatchOutcome | Promise<DispatchOutcome>,
): Promise<ToolEnvelope> {
  const requestId = makeRequestId();
  const claimedProject =
    typeof params === "object" && params !== null &&
    typeof (params as Record<string, unknown>)["projectId"] === "string"
      ? ((params as Record<string, unknown>)["projectId"] as string)
      : null;
  const fallbackProject = claimedProject ?? session.config.projectId;
  try {
    if (session.boundaryBroken) {
      throw new WorkbenchError(
        ERROR_CODES.POLICY_DENIED,
        `controlled-session boundary is broken (${session.boundaryBrokenReason ?? "host tools still active"}); refusing tool execution`,
      );
    }
    const validate = validatorFor(inputDef);
    if (!validate(params)) {
      throw new WorkbenchError(
        ERROR_CODES.SCHEMA_VALIDATION_FAILED,
        `${inputDef} failed contract validation: ${formatErrors(validate.errors)}`,
      );
    }
    const input = params as { projectId: string };
    const scope = session.scopeFor(input.projectId);
    const outcome = await dispatch(input as never, scope);
    const error =
      outcome.execution === "blocked"
        ? {
            code: ERROR_CODES.NOT_IMPLEMENTED,
            message: outcome.blockedMessage ?? "not implemented",
            retryable: false,
          }
        : null;
    return buildEnvelope({
      requestId,
      projectId: scope.projectId,
      snapshotId: outcome.snapshotId,
      execution: outcome.execution ?? "completed",
      data: outcome.data,
      error,
      ...(outcome.diagnostics !== undefined ? { diagnostics: outcome.diagnostics } : {}),
      ...(outcome.artifacts !== undefined ? { artifacts: outcome.artifacts } : {}),
    });
  } catch (err) {
    return failureEnvelope(requestId, fallbackProject, null, err);
  }
}
