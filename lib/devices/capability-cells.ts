/**
 * Capability matrices for the device console.
 *
 * Two vocabularies, one cell model. `CapabilityId` (platform surfaces —
 * camera, shell, headless) and `HostFeatureId` (versioned operation contracts
 * a Host advertises) are different value spaces owned by different modules, so
 * they are projected into the same {@link DeviceCapabilityCell} shape without
 * ever being merged into a third vocabulary.
 *
 * The rule this module exists to enforce: **"never told us" is not "no".**
 * `pairedDevices.capabilities` has been written on every connect since
 * ADR-0060 and rendered nowhere, so the console is the first surface that has
 * to decide what an unreported device looks like. Painting it as a full column
 * of misses would state twenty negative facts the device never gave.
 */

import {
  CORE_CAPABILITY_IDS,
  isCapabilityId,
  capabilitiesForPlatform,
  type CapabilityId,
} from "@/lib/platform/capabilities"
import {
  HOST_FEATURE_IDS,
  type HostFeatureId,
  type HostFeatureManifest,
} from "@/lib/platform/host-feature-manifest"
import type { Platform } from "@/lib/platform/detect"
import type { DevicePlatform } from "@/types/mobile/paired-device"
import type { DeviceCapabilityCell } from "./types"

/**
 * Host features that run work, as opposed to proxying it.
 *
 * Lifted verbatim out of `components/settings/remote-hosts/tabs/hosts-tab.tsx`
 * where it grouped the badge wall. It is a presentation grouping, not a
 * capability check — nothing gates on it.
 */
export const HOST_EXECUTION_FEATURES: ReadonlySet<HostFeatureId> = new Set<HostFeatureId>([
  "claude.host-tools",
  "skills.catalog",
  "skills.session-attach",
  "skills.atomic-install",
  "external-bridge.lifecycle",
  "external-bridge.managed-relay",
  "external-bridge.direct-tls",
  "workflow.execution",
])

/**
 * Map a device's self-reported platform onto a capability baseline platform.
 *
 * `"unknown"` deliberately has no baseline: a device that would not name its
 * platform gets no inferred capabilities, because the inference would be built
 * on nothing.
 */
export function baselinePlatformFor(platform: DevicePlatform | undefined): Platform | undefined {
  switch (platform) {
    case "ios":
    case "android":
      return "mobile"
    case "web":
      return "web"
    default:
      return undefined
  }
}

export interface PlatformCapabilityInput {
  /** Ids the device reported, verbatim. Unknown-to-us ids round-trip. */
  reported?: readonly string[]
  /** Epoch ms of the report. `undefined` means it never reported. */
  reportedAt?: number
  /** Baseline to fall back on when nothing was reported. */
  platform?: Platform
  /** Set for the local row, whose capabilities are probed rather than sent. */
  source?: DeviceCapabilityCell["source"]
}

/**
 * Platform capability cells, in catalog order, then reported plugin ids.
 *
 * When the device HAS reported, the answer is complete: anything missing is
 * `absent`. When it has NOT, nothing is `absent` — baseline members become
 * `expected` (inferred, unconfirmed) and everything else stays `unknown`.
 */
export function buildPlatformCapabilityCells(
  input: PlatformCapabilityInput
): DeviceCapabilityCell[] {
  const hasReport = input.reportedAt !== undefined && input.reported !== undefined
  const reported = new Set(input.reported ?? [])
  const baseline: ReadonlySet<CapabilityId> = new Set(
    input.platform ? capabilitiesForPlatform(input.platform) : []
  )
  const source = input.source ?? (hasReport ? "device-report" : "platform-baseline")

  const pluginIds = [...reported]
    .filter((id) => !(CORE_CAPABILITY_IDS as readonly string[]).includes(id) && isCapabilityId(id))
    .sort()

  const ids: string[] = [...CORE_CAPABILITY_IDS, ...pluginIds]

  return ids.map((id) => {
    if (hasReport) {
      return {
        id,
        group: "platform" as const,
        state: reported.has(id) ? ("reported" as const) : ("absent" as const),
        source,
      }
    }
    return {
      id,
      group: "platform" as const,
      state: baseline.has(id as CapabilityId) ? ("expected" as const) : ("unknown" as const),
      source,
    }
  })
}

/**
 * Host feature cells, split into the execution and proxy groups.
 *
 * A missing manifest means the client never completed a capability exchange
 * with this Host, not that the Host lacks every feature — so the whole table
 * is `unknown` rather than a wall of misses.
 */
export function buildHostFeatureCells(
  manifest: HostFeatureManifest | undefined
): DeviceCapabilityCell[] {
  return HOST_FEATURE_IDS.map((feature) => {
    const group = HOST_EXECUTION_FEATURES.has(feature)
      ? ("host-execution" as const)
      : ("host-proxy" as const)
    if (!manifest) {
      return { id: feature, group, state: "unknown" as const, source: "host-manifest" as const }
    }
    const descriptor = manifest.features[feature]
    if (!descriptor) {
      return { id: feature, group, state: "absent" as const, source: "host-manifest" as const }
    }
    // `operations` is required by the type but arrives over the wire from a
    // host we do not control, and a manifest that names a feature without
    // listing its operations must degrade to "no detail" rather than taking
    // the whole matrix down with it.
    const operations = Array.isArray(descriptor.operations) ? descriptor.operations : []
    return {
      id: feature,
      group,
      state: "reported" as const,
      source: "host-manifest" as const,
      detail:
        operations.length > 0
          ? `v${descriptor.version} · ${operations.join(", ")}`
          : `v${descriptor.version}`,
    }
  })
}

/** Count cells by state, for the matrix header summary. */
export function summarizeCapabilityCells(
  cells: readonly DeviceCapabilityCell[]
): Record<DeviceCapabilityCell["state"], number> {
  const totals = { reported: 0, expected: 0, absent: 0, unknown: 0 }
  for (const cell of cells) totals[cell.state] += 1
  return totals
}
