import type { Platform } from "@/lib/platform/detect"
import type { OperationAvailability } from "./operation-availability"

export type RuntimeRecoveryDestination =
  | { kind: "none" }
  | { kind: "route"; href: string }
  | { kind: "local-settings"; section: "companion" }

/** Shared routing policy for runtime notices and the status-bar affordance. */
export function resolveRuntimeRecovery(
  availability: OperationAvailability,
  platform: Platform
): RuntimeRecoveryDestination {
  if (platform === "tauri") {
    return isRecoverable(availability.state)
      ? { kind: "local-settings", section: "companion" }
      : { kind: "none" }
  }
  if (availability.state === "requires-pairing") {
    return { kind: "route", href: "/pair?mode=add" }
  }
  if (
    availability.state !== "offline" &&
    availability.state !== "incompatible" &&
    availability.state !== "requires-grant"
  ) {
    return { kind: "none" }
  }

  const params = new URLSearchParams({ mode: "recover", state: availability.state })
  if (availability.state === "requires-grant" && availability.requiredGrant) {
    params.set("requiredGrant", availability.requiredGrant)
  }
  return { kind: "route", href: `/pair?${params.toString()}` }
}

function isRecoverable(state: OperationAvailability["state"]): boolean {
  return (
    state === "requires-pairing" ||
    state === "requires-grant" ||
    state === "incompatible" ||
    state === "offline"
  )
}
