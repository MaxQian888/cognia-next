import { agentInvoke } from "../agent-transport"

export type BundledAgentBridgeId = "codebuff" | "crush-http" | "hermes-probe" | "hermes-acp"
export interface BundledAgentBridgeLaunch {
  command: string
  args: string[]
  sha256: string
}
const MARKERS: Record<BundledAgentBridgeId, string> = {
  codebuff: "--cognia-codebuff-bridge",
  "crush-http": "--cognia-crush-bridge",
  "hermes-probe": "--hermes-gateway-probe",
  "hermes-acp": "--cognia-hermes-acp",
}
const absolute = (value: string): boolean =>
  value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\")

/** Resolve through the existing native process host; no browser executable fallback. */
export async function resolveBundledAgentBridge(
  id: BundledAgentBridgeId
): Promise<BundledAgentBridgeLaunch> {
  if (!Object.hasOwn(MARKERS, id)) throw new Error(`Unsupported bundled agent bridge: ${id}`)
  const result = await agentInvoke<unknown>("resolve_bundled_agent_bridge", { id })
  const value = result as Partial<BundledAgentBridgeLaunch> | null
  if (
    !value ||
    typeof value.command !== "string" ||
    !absolute(value.command) ||
    !Array.isArray(value.args) ||
    value.args.length !== 2 ||
    typeof value.args[0] !== "string" ||
    !absolute(value.args[0]) ||
    !value.args[0].replaceAll("\\", "/").endsWith(`/native-agents/${id}.cjs`) ||
    value.args[1] !== MARKERS[id] ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error(
      `The native host did not return a verified ${id} bridge; rebuild/reinstall Cognia's native agent assets`
    )
  return { command: value.command, args: [...value.args], sha256: value.sha256 }
}
