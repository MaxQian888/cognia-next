/**
 * Which of the Host's sandbox drivers runs a placed spawn (ADR-0221 D9).
 *
 * A Host's driver status lists its provider set — the local driver as
 * `local`, every remote provider by id. A project's `runtime.target` picks
 * among them:
 *
 * - `local`: the local driver, which must exist.
 * - `provider`: exactly that remote provider. An id the Host does not have
 *   is refused rather than run somewhere the project did not name.
 * - `auto` (or absent): the local driver when it attests the spec's minimum
 *   tier, else the Host's default remote provider when that one does.
 *
 * A Host that lists no providers has only its local driver (every Host
 * before ADR-0221), so `auto` and `local` place there exactly as before and
 * a named provider is refused.
 *
 * Pure: the driver status is read by the caller, so the whole decision is a
 * table test.
 */

import type { SandboxTarget } from "@/types/project-environment"
import {
  isolationTierMeets,
  LOCAL_SANDBOX_PROVIDER_ID,
  type IsolationTier,
} from "@/types/sandbox/environment-spec"
import type { SandboxProviderView } from "@/types/sandbox/remote-sandboxes"

export type SandboxTargetChoice =
  /** The local driver: the placement names no provider. */
  | { kind: "local"; reason: "only-driver" | "requested" | "attests-tier" }
  /** A remote provider: the placement names it and carries a workspace. */
  | { kind: "remote"; providerId: string; reason: "requested" | "default-provider" }
  /**
   * Nothing on this Host can run it. `sandbox_provider_unknown` is a
   * configuration answer (refused); `sandbox_provider_unavailable` is the
   * infrastructure's (the fault rule decides).
   */
  | {
      kind: "unavailable"
      code: "sandbox_provider_unknown" | "sandbox_provider_unavailable"
      detail: Record<string, string>
    }

function attests(provider: SandboxProviderView, minimum: IsolationTier): boolean {
  return (
    provider.reachable && provider.availableTiers.some((tier) => isolationTierMeets(tier, minimum))
  )
}

export function chooseSandboxTarget(input: {
  target: SandboxTarget | undefined
  providers: readonly SandboxProviderView[]
  minimum: IsolationTier
}): SandboxTargetChoice {
  const { providers, minimum } = input
  const target = input.target ?? { kind: "auto" }
  const local = providers.find((provider) => provider.id === LOCAL_SANDBOX_PROVIDER_ID)

  if (providers.length === 0) {
    if (target.kind === "provider") {
      return {
        kind: "unavailable",
        code: "sandbox_provider_unknown",
        detail: { providerId: target.providerId },
      }
    }
    return { kind: "local", reason: "only-driver" }
  }

  switch (target.kind) {
    case "local":
      return local
        ? { kind: "local", reason: "requested" }
        : {
            kind: "unavailable",
            code: "sandbox_provider_unknown",
            detail: { providerId: LOCAL_SANDBOX_PROVIDER_ID },
          }
    case "provider": {
      const named = providers.find(
        (provider) => provider.id === target.providerId && provider.remote
      )
      return named
        ? { kind: "remote", providerId: named.id, reason: "requested" }
        : {
            kind: "unavailable",
            code: "sandbox_provider_unknown",
            detail: { providerId: target.providerId },
          }
    }
    case "auto": {
      if (local && attests(local, minimum)) return { kind: "local", reason: "attests-tier" }
      const fallback = providers.find((provider) => provider.remote && provider.isDefault)
      if (fallback && attests(fallback, minimum)) {
        return { kind: "remote", providerId: fallback.id, reason: "default-provider" }
      }
      return {
        kind: "unavailable",
        code: "sandbox_provider_unavailable",
        detail: { tier: minimum },
      }
    }
  }
}
