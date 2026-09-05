/**
 * One contract, every protocol.
 *
 * Each adapter has its own suite, and each of those suites knows about exactly
 * one protocol. What nothing checked was the SET: that the protocols the app
 * advertises and the protocols it can actually build are the same list, and
 * that they all behave the same way at the edges a caller depends on. The
 * existing invariant test asserts a hand-written array against another
 * hand-written array, so it holds even if `registerDefaultAdapters` forgets
 * one. A protocol advertised with no adapter behind it is accepted when the
 * user adds the agent and only throws `Unsupported protocol` at connect, which
 * is the worst possible moment to learn it.
 *
 * The cases below are generated from `SUPPORTED_EXTERNAL_AGENT_PROTOCOLS`, so a
 * new protocol joins them by existing, not by somebody remembering.
 */
import { SUPPORTED_EXTERNAL_AGENT_PROTOCOLS } from "./config-normalizer"
import { registerBuiltinProtocolAdapters } from "./manager"
import { BaseProtocolAdapter, ProtocolAdapterRegistry } from "./protocol-adapter"

/** A private registry, so the app's singleton is never mutated by a test. */
function builtinRegistry(): ProtocolAdapterRegistry {
  const registry = new ProtocolAdapterRegistry()
  registerBuiltinProtocolAdapters(registry)
  return registry
}

describe("the registered protocol set", () => {
  it("registers an adapter for every protocol the app advertises", () => {
    const registry = builtinRegistry()
    const missing = SUPPORTED_EXTERNAL_AGENT_PROTOCOLS.filter((p) => !registry.has(p))
    expect(missing).toEqual([])
  })

  it("advertises every protocol it registers", () => {
    // The other direction. An adapter that is registered but not advertised is
    // unreachable: `config-normalizer` rejects the config before anything can
    // ask the registry for it.
    const advertised = new Set<string>(SUPPORTED_EXTERNAL_AGENT_PROTOCOLS)
    const orphans = builtinRegistry()
      .getProtocols()
      .filter((p) => !advertised.has(p))
    expect(orphans).toEqual([])
  })

  it("covers the seven protocols this repository ships", () => {
    // A literal list as well, so DELETING a protocol from both sides at once
    // still has to be a deliberate edit to this file.
    expect([...SUPPORTED_EXTERNAL_AGENT_PROTOCOLS].sort()).toEqual([
      "a2a",
      "acp",
      "codex-app-server",
      "dsh-sdk",
      "opencode",
      "opencode-v2",
      "pi-rpc",
    ])
  })
})

describe.each(SUPPORTED_EXTERNAL_AGENT_PROTOCOLS.map((p) => [p] as const))(
  "%s adapter contract",
  (protocol) => {
    it("can be built from the registry", () => {
      expect(builtinRegistry().create(protocol)).toBeDefined()
    })

    it("names itself the same thing the registry files it under", () => {
      // A mismatch is not cosmetic. Events carry `adapter.protocol`, so a
      // wrongly named adapter files its telemetry, its trace spans and its
      // capability facts under a protocol nobody is running.
      expect(builtinRegistry().create(protocol)?.protocol).toBe(protocol)
    })

    it("builds a fresh instance per call, so two agents never share state", () => {
      const registry = builtinRegistry()
      expect(registry.create(protocol)).not.toBe(registry.create(protocol))
    })

    it("extends the shared base rather than reimplementing the surface", () => {
      expect(builtinRegistry().create(protocol)).toBeInstanceOf(BaseProtocolAdapter)
    })

    it("starts disconnected", () => {
      expect(builtinRegistry().create(protocol)?.isConnected()).toBe(false)
    })

    it("reports a settled failure when asked to run before it is connected", async () => {
      const adapter = builtinRegistry().create(protocol)
      if (!adapter) throw new Error(`no adapter for ${protocol}`)
      // The failure mode this rules out is silence. A turn sent to an adapter
      // that never connected has to come back, one way or the other, rather
      // than staying pending until the run's wall clock gives up with nothing
      // to say. Either shape is accepted, because both are reportable.
      const settled = await adapter
        .execute("no-such-session", { prompt: "hello" }, { timeout: 1_000 })
        .then(
          (result) => ({ rejected: false as const, result }),
          (error: unknown) => ({ rejected: true as const, error })
        )
      if (settled.rejected) {
        expect(settled.error).toBeDefined()
        return
      }
      expect(settled.result.success).toBe(false)
      expect(String(settled.result.error ?? "")).not.toBe("")
    })

    it("survives disconnect on an adapter that never connected", async () => {
      const adapter = builtinRegistry().create(protocol)
      if (!adapter) throw new Error(`no adapter for ${protocol}`)
      // Cleanup runs on paths where connect failed, so this is a real call
      // order, not a hypothetical one.
      await expect(adapter.disconnect()).resolves.not.toThrow()
      expect(adapter.isConnected()).toBe(false)
    })

    it("claims no capabilities before it has spoken to the agent", () => {
      const adapter = builtinRegistry().create(protocol)
      if (!adapter) throw new Error(`no adapter for ${protocol}`)
      // Capabilities are DISCOVERED at connect. An adapter that answered with a
      // hardcoded matrix here would let the negotiator believe things about an
      // agent nobody has handshaked with, and the belief would survive a
      // connect that failed.
      expect(adapter.capabilities).toBeUndefined()
      expect(adapter.tools).toBeUndefined()
    })

    it("starts in the disconnected status, not an empty one", () => {
      // `connectionStatus` drives the badge the user reads. An adapter that
      // left it undefined renders as a blank state rather than as "not
      // connected".
      expect(builtinRegistry().create(protocol)?.connectionStatus).toBe("disconnected")
    })
  }
)
