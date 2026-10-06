import { hasLaunchableRuntime, isMigratable } from "@cognia/agent-contracts/ecosystem"
import {
  cancelIsolatedToSession,
  requiresReconnectAfterCancel,
} from "@cognia/agent-contracts/semantics"
import { PI_RPC_EXECUTION_SEMANTICS, PI_RPC_PROTOCOL, piManifest } from "./manifest"
import { PI_MAX_CONCURRENT_PROCESSES } from "./rpc-client"

describe("piManifest", () => {
  it("is frozen data naming the pi-rpc protocol and its semantics", () => {
    expect(Object.isFrozen(piManifest)).toBe(true)
    expect(piManifest.protocols).toEqual([
      { protocol: PI_RPC_PROTOCOL, semantics: PI_RPC_EXECUTION_SEMANTICS },
    ])
  })

  it("declares a turn-scoped cancel that keeps the session", () => {
    expect(requiresReconnectAfterCancel(PI_RPC_EXECUTION_SEMANTICS)).toBe(false)
    expect(cancelIsolatedToSession(PI_RPC_EXECUTION_SEMANTICS)).toBe(true)
    expect(PI_RPC_EXECUTION_SEMANTICS.maxProcesses).toBe(PI_MAX_CONCURRENT_PROCESSES)
  })

  it("publishes the ecosystem row the catalog lists", () => {
    expect(piManifest.ecosystem).toMatchObject({
      id: "pi",
      runtimeIds: ["pi"],
      sessionSourceIds: ["pi"],
      migrationVendor: "pi",
      configRootKey: "piAgentDir",
    })
    expect(hasLaunchableRuntime(piManifest.ecosystem)).toBe(true)
    expect(isMigratable(piManifest.ecosystem)).toBe(true)
  })
})
