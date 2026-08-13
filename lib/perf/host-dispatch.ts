import { detectPlatform } from "@/lib/platform/detect"
import type { PerfOpenLeaseRequest } from "./backend/types"
import { getPerformanceHostAdapter } from "./host-adapter"

const COMMANDS = new Set([
  "perf_open_lease",
  "perf_renew_lease",
  "perf_close_lease",
  "perf_lease_snapshot",
  "perf_read_observations",
  "perf_hotspots",
  "perf_list_traces",
  "perf_trace_open",
  "perf_trace_read_chunk",
  "perf_trace_close",
  "perf_system_details",
])

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`)
  }
  return value
}

export function isPerformanceHostCommand(command: string): boolean {
  return COMMANDS.has(command)
}

export async function dispatchPerformanceHostCommand(
  command: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (!isPerformanceHostCommand(command)) throw new Error(`unsupported perf command: ${command}`)
  const callerDeviceId = requiredString(payload, "callerDeviceId")
  if (detectPlatform() === "headless") {
    const adapter = getPerformanceHostAdapter()
    switch (command) {
      case "perf_open_lease": {
        const input = payload.input
        if (!input || typeof input !== "object") throw new Error("input is required")
        return adapter.open({
          ...(input as PerfOpenLeaseRequest),
          deviceId: callerDeviceId,
        })
      }
      case "perf_renew_lease":
        return adapter.renew(requiredString(payload, "leaseId"), callerDeviceId)
      case "perf_close_lease":
        return adapter.close(requiredString(payload, "leaseId"), callerDeviceId)
      case "perf_lease_snapshot":
        return adapter.snapshot(requiredString(payload, "leaseId"), callerDeviceId)
      case "perf_read_observations": {
        const afterSequence = payload.afterSequence
        if (afterSequence !== undefined && !Number.isSafeInteger(afterSequence)) {
          throw new Error("afterSequence must be a safe integer")
        }
        return adapter.readObservations(
          requiredString(payload, "leaseId"),
          afterSequence as number | undefined,
          callerDeviceId
        )
      }
      case "perf_hotspots":
        throw new Error("unsupported: runtime.dial9 is unavailable on Node/headless hosts")
      case "perf_list_traces":
        throw new Error("unsupported: host traces are unavailable on Node/headless hosts")
      case "perf_trace_open":
      case "perf_trace_read_chunk":
      case "perf_trace_close":
        throw new Error("unsupported: trace transfer is unavailable on Node/headless hosts")
      case "perf_system_details": {
        const os = await import("node:os")
        return {
          os: os.platform(),
          osVersion: os.release(),
          kernelVersion: os.version(),
          arch: os.arch(),
          family: "node",
          hostname: os.hostname(),
          cpu: os.cpus().at(0)?.model ?? null,
          cpuCount: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          usedMemoryBytes: os.totalmem() - os.freemem(),
          appVersion: process.env.npm_package_version ?? "unknown",
          tauriVersion: "unsupported",
          profile: process.env.NODE_ENV ?? "development",
          enabledFeatures: ["node-headless", "performance.observe"],
        }
      }
    }
  }

  const { invoke } = await import("@tauri-apps/api/core")
  const args = { ...payload, callerDeviceId, deviceId: callerDeviceId, remote: true }
  if (command === "perf_open_lease") {
    args.input = {
      ...(payload.input as PerfOpenLeaseRequest),
      deviceId: callerDeviceId,
    }
  }
  return invoke(command, args)
}
