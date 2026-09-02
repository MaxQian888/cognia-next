/**
 * Map the provider readiness vocabulary (`ProviderGuardResult`,
 * `ProviderSetupChecklist`) and the host's execution surfaces onto the
 * operation contract's `ProviderOperationAvailability`. Pure: no I/O, no
 * app-tree imports.
 */

import type {
  ProviderOperationAvailability,
  ProviderOperationSurface,
} from "@cognia/provider-types"

import type { ProviderGuardResult, ProviderSetupChecklist } from "../providers/completeness"

export interface ResolveOperationAvailabilityInput {
  /** Runtime eligibility for the provider (credential, base URL, enabled). */
  guard?: ProviderGuardResult
  /** Setup checklist. Consulted when the guard allows but setup is incomplete. */
  checklist?: ProviderSetupChecklist
  /** Surfaces the operation's descriptor permits. */
  descriptorSurfaces?: readonly ProviderOperationSurface[]
  /** Surfaces the current host can execute on. */
  hostSurfaces?: readonly ProviderOperationSurface[]
}

export interface ResolvedOperationAvailability {
  availability: ProviderOperationAvailability
  note?: string
}

/**
 * Order matters: a disabled provider is `unavailable` before anything else,
 * a missing host surface is `needs-host` before credentials (no key fixes a
 * renderer that cannot reach the endpoint), then auth, then config.
 */
export function resolveOperationAvailability(
  input: ResolveOperationAvailabilityInput
): ResolvedOperationAvailability {
  const { guard, checklist, descriptorSurfaces, hostSurfaces } = input

  if (guard && !guard.allowed && guard.code === "provider_disabled") {
    return { availability: "unavailable", note: guard.reason ?? "provider disabled" }
  }

  if (descriptorSurfaces && hostSurfaces) {
    const reachable = descriptorSurfaces.some((surface) => hostSurfaces.includes(surface))
    if (!reachable) {
      return {
        availability: "needs-host",
        note: `no host surface among ${descriptorSurfaces.join(", ")} is available here`,
      }
    }
  }

  if (guard && !guard.allowed) {
    switch (guard.code) {
      case "missing_credential":
        return { availability: "needs-auth", note: guard.reason }
      case "missing_base_url":
      case "invalid_base_url":
        return { availability: "needs-config", note: guard.reason }
      default:
        return { availability: "unavailable", note: guard.reason }
    }
  }

  if (checklist && !checklist.isComplete) {
    const pending = checklist.steps.find((step) => !step.done)
    switch (pending?.id) {
      case "credential":
        return { availability: "needs-auth", note: pending.reason }
      case "base_url":
      case "default_model":
        return { availability: "needs-config", note: pending.reason }
      default:
        // Verification pending is not a blocker: the call itself verifies.
        return { availability: "ready" }
    }
  }

  return { availability: "ready" }
}
