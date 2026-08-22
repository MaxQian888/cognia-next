/**
 * These tests read the REAL `protocol/agent-capabilities.json`. That is
 * deliberate: the manifest is checked-in data, and a suite that only exercised
 * a fixture would pass while the shipped file was malformed.
 */
import MANIFEST from "@/protocol/agent-capabilities.json"
import {
  BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS,
  EXTERNAL_AGENT_CAPABILITY_IDS,
} from "@cognia/agent-config-types/external-agent-capability"

import {
  adapterMethodCapabilityLayer,
  externalCapabilityManifest,
  externalCapabilityManifestVersion,
  presetCapabilityLayer,
  protocolCapabilityLayer,
} from "./capability-manifest"

describe("the shipped manifest", () => {
  it("parses and validates", () => {
    expect(() => externalCapabilityManifest()).not.toThrow()
    expect(externalCapabilityManifestVersion()).toBeGreaterThanOrEqual(1)
  })

  it("carries a COMPLETE row for every registered protocol", () => {
    const manifest = externalCapabilityManifest()
    for (const protocol of BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS) {
      const row = manifest.protocols[protocol]
      expect(row).toBeDefined()
      for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
        expect(row.capabilities[id]).toBeDefined()
      }
    }
  })

  it("never backs a verdict with `none` evidence", () => {
    const manifest = externalCapabilityManifest()
    for (const [protocol, row] of Object.entries(manifest.protocols)) {
      for (const [id, cell] of Object.entries(row.capabilities)) {
        if (cell.evidence === "none") {
          expect(`${protocol}.${id}=${cell.level}`).toBe(`${protocol}.${id}=unknown`)
        }
      }
    }
  })

  it("explains every non-native verdict", () => {
    const manifest = externalCapabilityManifest()
    for (const [protocol, row] of Object.entries(manifest.protocols)) {
      for (const [id, cell] of Object.entries(row.capabilities)) {
        if (cell.level === "unsupported" || cell.level === "equivalent") {
          expect(`${protocol}.${id}:${cell.reasonKey ?? "MISSING"}`).not.toContain("MISSING")
        }
      }
    }
  })

  it("only refines presets against their own protocol", () => {
    const manifest = externalCapabilityManifest()
    for (const entry of Object.values(manifest.presetRefinements)) {
      expect(BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS).toContain(entry.protocol)
    }
  })

  it("records the facts the SSOT was built to stop each surface guessing", () => {
    const manifest = externalCapabilityManifest()
    // dsh-sdk cannot carry a mid-turn approval (`dsh-sdk-client.ts` throws on
    // `respondToPermission`), yet the permission-mode table used to claim every
    // mode for it.
    expect(manifest.protocols["dsh-sdk"].capabilities["permissions.interrupt-resume"].level).toBe(
      "unsupported"
    )
    // Only ACP forwards MCP servers at session/new; Codex reaches the same
    // outcome through a per-thread config override, and nothing else can.
    expect(manifest.protocols.acp.capabilities.mcp.level).toBe("native")
    expect(manifest.protocols["codex-app-server"].capabilities.mcp.level).toBe("equivalent")
    expect(manifest.protocols.opencode.capabilities.mcp.level).toBe("unsupported")
    expect(manifest.protocols["pi-rpc"].capabilities.mcp.level).toBe("unsupported")
    // Only the native Codex app-server enumerates models without a session.
    expect(manifest.protocols["codex-app-server"].capabilities["models.list"].level).toBe("native")
    expect(manifest.protocols.acp.capabilities["models.list"].level).toBe("unsupported")
  })

  it("answers steering per protocol, and lets the adapter layer tighten it", () => {
    // The CLI's old table claimed `steer` for OpenCode, whose adapter has no
    // `steerTurn` and whose protocol has no mid-turn input method. Only two
    // protocols actually do.
    const manifest = externalCapabilityManifest()
    expect(manifest.protocols["codex-app-server"].capabilities.steer.level).toBe("native")
    expect(manifest.protocols["pi-rpc"].capabilities.steer.level).toBe("native")
    for (const protocol of ["acp", "opencode", "opencode-v2", "dsh-sdk", "a2a"] as const) {
      expect(manifest.protocols[protocol].capabilities.steer.level).toBe("unsupported")
    }
    // A protocol slot is necessary but not sufficient: if Cognia's adapter
    // never wired `steerTurn`, layer 3 tightens the row back to unsupported.
    expect(manifest.adapterMethodCapabilities.steer).toBe("steerTurn")
  })
})

describe("protocolCapabilityLayer", () => {
  it("returns the manifest row for a registered protocol", () => {
    const layer = protocolCapabilityLayer("acp")
    expect(layer.layer).toBe("protocol")
    expect(layer.cells.streaming?.level).toBe("native")
  })

  it("returns a complete unknown row for a protocol with no manifest entry", () => {
    // A plugin protocol declares its own row; a legacy `http` config has none
    // at all. Both must produce every id as `unknown`, never an empty object —
    // an absent cell reads as "unsupported" at every call site downstream.
    for (const protocol of ["my-plugin:demo", "http"]) {
      const layer = protocolCapabilityLayer(protocol)
      for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
        expect(layer.cells[id]).toEqual({
          level: "unknown",
          evidence: "none",
          reasonKey: "noManifestRow",
        })
      }
    }
  })
})

describe("presetCapabilityLayer", () => {
  it("is empty for an unknown or absent preset", () => {
    expect(presetCapabilityLayer(undefined).cells).toEqual({})
    expect(presetCapabilityLayer("not-a-preset").cells).toEqual({})
  })

  it("carries the DSH interactive channel's committed-replies-only clamp", () => {
    const layer = presetCapabilityLayer("deepseek-harness-acp")
    expect(layer.layer).toBe("refinement")
    expect(layer.cells.streaming?.level).toBe("unsupported")
    expect(layer.cells["tools.ordinary"]?.level).toBe("unsupported")
  })
})

describe("adapterMethodCapabilityLayer", () => {
  it("is empty without an adapter instance", () => {
    expect(adapterMethodCapabilityLayer(undefined).cells).toEqual({})
  })

  it("proves a capability from a present method and blames Cognia for a missing one", () => {
    const layer = adapterMethodCapabilityLayer({ steerTurn: () => undefined })
    expect(layer.layer).toBe("adapter-methods")
    expect(layer.cells.steer).toEqual({
      level: "native",
      evidence: "adapter-code",
      reasonKey: "adapterMethod.steerTurn",
    })
    expect(layer.cells["set-model"]).toEqual({
      level: "unsupported",
      evidence: "adapter-code",
      reasonKey: "adapterMethodMissing",
    })
  })

  it("ignores a non-function property with the right name", () => {
    const layer = adapterMethodCapabilityLayer({ steerTurn: true })
    expect(layer.cells.steer?.level).toBe("unsupported")
  })
})

describe("manifest / vocabulary parity", () => {
  it("lists exactly the vocabulary in `capabilityIds`", () => {
    expect([...(MANIFEST as { capabilityIds: string[] }).capabilityIds].sort()).toEqual(
      [...EXTERNAL_AGENT_CAPABILITY_IDS].sort()
    )
  })
})
