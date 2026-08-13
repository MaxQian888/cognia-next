import type {
  PerfFrame,
  PerfOpenLeaseRequest,
  PerfOpenLeaseResult,
  PerfSnapshot,
} from "./backend/types"

export interface PerformanceHostAdapter {
  open(input: PerfOpenLeaseRequest): Promise<PerfOpenLeaseResult>
  renew(leaseId: string, deviceId?: string): Promise<void>
  close(leaseId: string, deviceId?: string): Promise<void>
  snapshot(leaseId: string, deviceId?: string): Promise<PerfSnapshot>
  readObservations(leaseId: string, afterSequence?: number, deviceId?: string): Promise<PerfFrame[]>
  stop(): Promise<void>
}

let adapter: PerformanceHostAdapter | null = null

export function registerPerformanceHostAdapter(next: PerformanceHostAdapter): () => void {
  if (adapter && adapter !== next) {
    throw new Error("performance host adapter is already registered")
  }
  adapter = next
  return () => {
    if (adapter === next) adapter = null
  }
}

export function getPerformanceHostAdapter(): PerformanceHostAdapter {
  if (!adapter) throw new Error("performance host is unsupported in this runtime")
  return adapter
}

export function resetPerformanceHostAdapterForTesting(): void {
  adapter = null
}
