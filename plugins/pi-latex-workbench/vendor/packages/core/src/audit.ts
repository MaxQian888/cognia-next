/**
 * Audit writer: append-only audit_events rows carrying the principal from the
 * trusted RequestContext, the action, the scoped resource and the outcome.
 */
import { randomUUID } from "node:crypto";
import { canonicalJson, utcNowIso } from "@latexwb/contracts";
import type { WorkbenchStore } from "@latexwb/storage";
import type { RequestContext } from "./context.ts";

export interface AuditInput {
  action: string;
  resourceId?: string | null;
  outcome: string;
  detail?: unknown;
}

export function writeAuditEvent(
  store: WorkbenchStore,
  ctx: RequestContext,
  projectId: string,
  input: AuditInput,
): string {
  const eventId = randomUUID();
  store.insertAuditEvent(
    { workspaceId: ctx.workspaceId, projectId },
    {
      eventId,
      principalId: ctx.principalId,
      action: input.action,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome,
      detailJson: canonicalJson(input.detail ?? {}),
      createdAt: utcNowIso(),
    },
  );
  return eventId;
}
