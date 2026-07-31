import type { Platform } from "@/lib/platform/detect"

export type RuntimeTargetKind = "standalone" | "companion" | "legacy-readonly"
export type CompanionHostKind = "desktop" | "cloud"

interface RuntimeTargetBase {
  /** Stable identifier used by persistence, queues, and diagnostics. */
  id: string
  kind: RuntimeTargetKind
  platform: Extract<Platform, "web" | "mobile">
}

export interface StandaloneRuntimeTarget extends RuntimeTargetBase {
  kind: "standalone"
}

export interface CompanionRuntimeTarget extends RuntimeTargetBase {
  kind: "companion"
  hostKind: CompanionHostKind
}

export interface LegacyReadonlyRuntimeTarget extends RuntimeTargetBase {
  kind: "legacy-readonly"
}

export type RuntimeTarget =
  StandaloneRuntimeTarget | CompanionRuntimeTarget | LegacyReadonlyRuntimeTarget

export interface RuntimeTargetResolutionInput {
  platform: Platform
  mobileRuntimeMode: "paired" | "standalone" | undefined
  webCompanionConfigured: boolean
}

/**
 * Resolve the execution target for shells that are clients of Cognia.
 *
 * Tauri and headless are execution hosts themselves, so they deliberately
 * return `null`. Mobile remains unselected until onboarding persists a mode.
 * An ordinary browser is standalone unless it has an explicit Companion
 * target; that makes BYOK a real Web execution path instead of WebStub.
 */
export function resolveRuntimeTarget(input: RuntimeTargetResolutionInput): RuntimeTarget | null {
  switch (input.platform) {
    case "tauri":
    case "headless":
      return null
    case "mobile":
      if (input.mobileRuntimeMode === "standalone") {
        return { id: "mobile-standalone", kind: "standalone", platform: "mobile" }
      }
      if (input.mobileRuntimeMode === "paired") {
        return {
          id: "mobile-companion",
          kind: "companion",
          platform: "mobile",
          hostKind: "desktop",
        }
      }
      return null
    case "web":
      return input.webCompanionConfigured
        ? {
            id: "web-companion",
            kind: "companion",
            platform: "web",
            hostKind: "cloud",
          }
        : { id: "web-standalone", kind: "standalone", platform: "web" }
  }
}

export function isStandaloneRuntimeTarget(
  target: RuntimeTarget | null
): target is StandaloneRuntimeTarget {
  return target?.kind === "standalone"
}
