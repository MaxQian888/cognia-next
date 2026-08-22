import { admitNegotiatedExternalAgent, preflightExternalAgent } from "./capability-preflight"
import { negotiateCapabilityProfile } from "./capability-profile"

const always = () => true
const never = () => false

describe("preflightExternalAgent", () => {
  it("admits a registered protocol with no hard requirements", () => {
    const result = preflightExternalAgent({ protocol: "acp", hasAdapter: always })
    expect(result.ok).toBe(true)
    expect(result.profile.negotiated).toBe(false)
  })

  it("refuses a legacy protocol as unrunnable, not as merely unsupported", () => {
    for (const protocol of ["http", "websocket", "custom"]) {
      const result = preflightExternalAgent({ protocol, hasAdapter: always })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe("config_error")
      expect(result.error.detail?.reason).toBe("adapter_unavailable")
      expect(result.error.message).toContain("never been runnable")
    }
  })

  it("refuses a plugin protocol whose plugin is not enabled", () => {
    const result = preflightExternalAgent({ protocol: "acme:weird", hasAdapter: never })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("config_error")
    expect(result.error.detail).toMatchObject({ reason: "adapter_unavailable", plugin: true })
    expect(result.error.message).toContain("not enabled")
  })

  it("refuses a built-in protocol whose adapter never registered", () => {
    const result = preflightExternalAgent({ protocol: "acp", hasAdapter: never })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail).toMatchObject({ plugin: false })
  })

  it("refuses a requirement the protocol row DECLARES unsupported", () => {
    // `pi-rpc` has no per-session mcpServers parameter.
    const result = preflightExternalAgent({
      protocol: "pi-rpc",
      requires: ["mcp"],
      hasAdapter: always,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("unsupported_capability")
    expect(result.error.capability).toBe("mcp")
    expect(result.error.detail?.missing).toEqual([
      expect.objectContaining({ capability: "mcp", level: "unsupported" }),
    ])
  })

  it("admits an UNKNOWN requirement so the handshake gets its say", () => {
    // Nothing has measured whether ACP agents run tools in parallel: the spec
    // does not say and no handshake field reports it. Refusing here would
    // reject an agent that does.
    const result = preflightExternalAgent({
      protocol: "acp",
      requires: ["tools.parallel"],
      hasAdapter: always,
    })
    expect(result.ok).toBe(true)
  })

  it("reports an external-only capability in detail rather than in `capability`", () => {
    const result = preflightExternalAgent({
      protocol: "acp",
      requires: ["models.list"],
      hasAdapter: always,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.capability).toBeUndefined()
    expect(result.error.detail?.missing).toEqual([
      expect.objectContaining({ capability: "models.list" }),
    ])
  })

  it("refuses everything when the platform cannot sandbox", () => {
    const result = preflightExternalAgent({
      protocol: "acp",
      requires: ["streaming"],
      ceilings: { sandboxAvailable: false },
      hasAdapter: always,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail?.missing).toEqual([
      expect.objectContaining({ capability: "streaming", reasonKey: "noSandbox" }),
    ])
  })
})

describe("admitNegotiatedExternalAgent", () => {
  it("refuses to admit a profile that was never negotiated", () => {
    const profile = negotiateCapabilityProfile({ protocol: "acp" })
    const result = admitNegotiatedExternalAgent({ profile })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail?.reason).toBe("profile_not_negotiated")
  })

  it("now treats an unmeasured requirement as fatal", () => {
    const profile = negotiateCapabilityProfile({ protocol: "acp", liveFacts: {} })
    // Nothing in the manifest, the adapter's methods or the handshake speaks to
    // parallel tool calls, so after the handshake `unknown` means "we asked
    // everything we can and still do not know" — which cannot back a promise.
    expect(profile.effective["tools.parallel"].level).toBe("unknown")
    const result = admitNegotiatedExternalAgent({ profile, requires: ["tools.parallel"] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("unsupported_capability")
    expect(result.error.detail?.missing).toEqual([
      expect.objectContaining({ capability: "tools.parallel", level: "unknown" }),
    ])
  })

  it("admits a requirement the protocol has and the adapter wired", () => {
    const profile = negotiateCapabilityProfile({
      protocol: "codex-app-server",
      adapter: { steerTurn: () => undefined },
      liveFacts: {},
    })
    expect(admitNegotiatedExternalAgent({ profile, requires: ["steer", "streaming"] })).toEqual({
      ok: true,
    })
  })

  it("refuses a protocol capability Cognia never wired", () => {
    // `turn/steer` exists in the Codex app-server schema, so the manifest row
    // is `native` — but a protocol slot Cognia's adapter does not call is not a
    // capability the session has.
    const profile = negotiateCapabilityProfile({
      protocol: "codex-app-server",
      adapter: {},
      liveFacts: {},
    })
    const result = admitNegotiatedExternalAgent({ profile, requires: ["steer"] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail?.missing).toEqual([
      expect.objectContaining({ capability: "steer", reasonKey: "adapterMethodMissing" }),
    ])
  })

  it("names the preset in the refusal so a user knows which backend said no", () => {
    const profile = negotiateCapabilityProfile({
      protocol: "opencode",
      presetId: "opencode-server",
      liveFacts: {},
    })
    const result = admitNegotiatedExternalAgent({ profile, requires: ["mcp"] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("opencode-server")
  })
})

describe("dormancy", () => {
  it("phase 2 has no production caller, and the resolver holds the check that matters", async () => {
    // `admitNegotiatedExternalAgent` is fully built and fully tested above,
    // which is exactly the condition under which this repo's dormant code
    // starts reading as live. Its un-negotiated refusal IS enforced — by
    // `resolveAgentExecutionSpec`, where no caller can skip it — but its
    // hard-requirement re-check has no input yet, and wiring it to an empty
    // requirement list would look like a gate while checking nothing.
    //
    // Delete this test the moment a surface declares external requirements.
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")

    const roots = [
      "lib/ai/agent",
      "cli/src/agent",
      "cli/src/runtime",
      "components/agent",
      "hooks/agent",
    ]
    const callers: string[] = []
    let scanned = 0
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
        if (full.endsWith("capability-preflight.ts")) continue
        scanned += 1
        if (readFileSync(full, "utf8").includes("admitNegotiatedExternalAgent(")) callers.push(full)
      }
    }
    for (const root of roots) walk(join(process.cwd(), root))

    // A mistyped root would make the sweep pass by looking at nothing.
    expect(scanned).toBeGreaterThan(200)
    expect(callers).toEqual([])
  })

  it("the un-negotiated refusal it duplicates is enforced where callers cannot skip it", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const source = readFileSync(
      join(process.cwd(), "lib/ai/agent/execution/resolve-agent-execution-spec.ts"),
      "utf8"
    )
    // Not a string match on a comment: this is the guard itself.
    expect(source).toMatch(/if \(!projection\?\.negotiated\) return undefined/)
  })
})
