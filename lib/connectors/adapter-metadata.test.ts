import {
  CONNECTOR_METADATA,
  findMetadataGaps,
  getConnectorMeta,
  listConnectorMetadata,
} from "./adapter-metadata"
import { ALL_PLATFORM_KINDS } from "@/types/connectors/platform-kind"

describe("lib/connectors/adapter-metadata", () => {
  it("covers every PlatformKind from the union", () => {
    // Every entry in ALL_PLATFORM_KINDS must have a metadata row, otherwise
    // the Discover sidebar would silently drop the platform.
    expect(findMetadataGaps()).toEqual([])
  })

  it("listConnectorMetadata returns entries in CONNECTOR_METADATA order", () => {
    expect(listConnectorMetadata()).toBe(CONNECTOR_METADATA)
  })

  it("getConnectorMeta resolves known platform kinds", () => {
    const t = getConnectorMeta("telegram")
    expect(t).toBeDefined()
    expect(t?.status).toBe("stable")
    expect(t?.iconName).toBe("Send")
  })

  it("github is exposed as beta (PR delivery plugin, no outbound)", () => {
    const gh = getConnectorMeta("github")
    expect(gh?.status).toBe("beta")
  })

  it("planned platforms cover everything not currently shipped by adapter-registry", () => {
    // Hard-coded ground truth — if adapter-registry adds a new built-in,
    // bump the status here in the same PR. Phase 1 builtins are telegram /
    // discord / slack / lark / onebot. The delivery-plugin github adapter
    // sits on beta.
    const stableSet = new Set(
      CONNECTOR_METADATA.filter((m) => m.status === "stable").map((m) => m.type)
    )
    expect(stableSet).toEqual(new Set(["telegram", "discord", "slack", "lark", "onebot"]))
  })

  it("never produces a duplicate type entry", () => {
    const types = CONNECTOR_METADATA.map((m) => m.type)
    expect(new Set(types).size).toBe(types.length)
  })

  it("every type listed is part of ALL_PLATFORM_KINDS", () => {
    for (const m of CONNECTOR_METADATA) {
      expect(ALL_PLATFORM_KINDS).toContain(m.type)
    }
  })
})
