import { isHeadlessHost } from "@/lib/platform/detect"

/**
 * The headless brain's installed CompanionTransport reaches its execution
 * host's ledger. Standalone CLI stdio has no host allocator. Resolve each
 * final cwd independently; never borrow another session's ambient port env.
 */
export async function resolveWorkspacePortEnv(cwd: string): Promise<Record<string, string>> {
  if (!isHeadlessHost()) return {}
  const { resolveWorkspacePortLeaseEnsure } = await import("@/lib/task-workspace/client")
  const lease = await resolveWorkspacePortLeaseEnsure(cwd, undefined, "host-loopback")
  if (!lease) return {}
  return {
    COGNIA_PORT: String(lease.basePort),
    COGNIA_PORT_COUNT: String(lease.portCount),
    PORT: String(lease.basePort),
  }
}
