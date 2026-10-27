import type { LumeResource } from "@/lib/automation/lume-client"
import type { SandboxConnectionRow, SandboxLifecycleState } from "@/types/sandbox"
import { defaultSandboxCapabilities, SANDBOX_CAPABILITY_REVISION } from "./connection-capabilities"

/** Safe display projection of an authenticated local Host receipt. */
export function projectLumeResource(
  resource: LumeResource,
  enabled: boolean,
  previous?: SandboxConnectionRow
): SandboxConnectionRow {
  const now = Date.now()
  const state: SandboxLifecycleState = [
    "creating",
    "starting",
    "running",
    "stopping",
    "stopped",
    "deleting",
    "uninitialized",
  ].includes(resource.state)
    ? (resource.state as SandboxLifecycleState)
    : "error"
  return {
    id: resource.connectionId,
    name: previous?.name ?? resource.vmName,
    provider: "lume",
    driver: "cua-driver",
    state,
    capabilities: defaultSandboxCapabilities("lume", "cua-driver"),
    capabilitiesRevision: SANDBOX_CAPABILITY_REVISION,
    config: {
      provider: "lume",
      contractVersion: 1,
      vmName: resource.vmName,
      resourceId: resource.resourceId,
      generation: resource.generation,
      bootEpoch: resource.bootEpoch,
      memoryMb: resource.memoryMb,
      readiness: { ...resource.readiness },
      quarantine: resource.quarantine,
      featureEnabled: enabled,
    },
    lastHealthStatus: resource.quarantine ? "error" : resource.readiness.vm ? "ok" : "unknown",
    lastHealthError: resource.lastErrorCode ?? undefined,
    lastHealthCheckAt: now,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}
