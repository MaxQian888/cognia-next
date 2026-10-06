import type { AgentCapabilityContribution } from "@cognia/agent-contracts/ecosystem"
import MANIFEST from "@/protocol/agent-capabilities.json"
import {
  INTEGRATION_CAPABILITIES,
  mergeIntegrationCapabilityRows,
  type CapabilityManifestFile,
} from "./capability-catalog"

const manifest = MANIFEST as unknown as CapabilityManifestFile

const cell = { level: "native", evidence: "adapter-code" } as const
const row = (label: string) => ({ label, note: "n", capabilities: { streaming: cell } })

const base: CapabilityManifestFile = {
  version: 1,
  protocols: { a: row("stale a"), kept: row("authored") },
  presetRefinements: { p: { protocol: "a", note: "stale", capabilities: {} } },
}

describe("mergeIntegrationCapabilityRows", () => {
  it("leaves the committed manifest unchanged: every package row matches its manifest", () => {
    expect(mergeIntegrationCapabilityRows(manifest, INTEGRATION_CAPABILITIES)).toEqual(manifest)
  })

  it("contributes every protocol row the manifest carries", () => {
    const contributed = new Set(
      INTEGRATION_CAPABILITIES.flatMap((entry) => Object.keys(entry.protocols ?? {}))
    )
    expect([...contributed].sort()).toEqual(Object.keys(manifest.protocols).sort())
  })

  it("replaces owned rows in place, appends new ones and keeps authored ones", () => {
    const merged = mergeIntegrationCapabilityRows(base, [
      {
        protocols: { b: row("B"), a: row("A") },
        presetRefinements: { p: { protocol: "b", note: "fresh", capabilities: {} } },
      },
    ])
    expect(Object.entries(merged.protocols).map(([key, value]) => [key, value.label])).toEqual([
      ["a", "A"],
      ["kept", "authored"],
      ["b", "B"],
    ])
    expect(merged.presetRefinements.p).toEqual({ protocol: "b", note: "fresh", capabilities: {} })
    expect(merged.version).toBe(1)
  })

  it("refuses double claims and refinements of a protocol without a row", () => {
    const one: AgentCapabilityContribution = { protocols: { a: row("A") } }
    expect(() => mergeIntegrationCapabilityRows(base, [one, one])).toThrow(/two capability rows/)
    const preset: AgentCapabilityContribution = {
      presetRefinements: { p: { protocol: "a", note: "", capabilities: {} } },
    }
    expect(() => mergeIntegrationCapabilityRows(base, [preset, preset])).toThrow(
      /two capability refinements/
    )
    expect(() =>
      mergeIntegrationCapabilityRows(base, [
        { presetRefinements: { q: { protocol: "missing", note: "", capabilities: {} } } },
      ])
    ).toThrow(/has no capability row/)
  })
})
