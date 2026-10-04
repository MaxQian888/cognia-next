/**
 * Capability enumeration (API_CONTRACT §1). grantedCapabilities come from the
 * host — never from project config or LLM parameters. human.review and
 * approval.grant exist only for authenticated user surfaces.
 */
import { WorkbenchError, ERROR_CODES } from "@latexwb/contracts";
import type { RequestContext } from "./context.ts";

export const CAPABILITIES = [
  "project.read",
  "project.write",
  "build.execute",
  "artifact.read",
  "metadata.lookup",
  "data.render",
  "release.create",
  "human.review",
  "approval.grant",
  "skill.resource.read",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

export function requireCapability(ctx: RequestContext, capability: Capability): void {
  if (!ctx.grantedCapabilities.has(capability)) {
    throw new WorkbenchError(
      ERROR_CODES.POLICY_DENIED,
      `principal ${ctx.principalId} lacks capability ${capability}`,
      { retryable: false },
    );
  }
}
