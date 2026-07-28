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

  it("does not model Marketplace integrations as Connector platforms", () => {
    expect(getConnectorMeta("github")).toBeUndefined()
    expect(ALL_PLATFORM_KINDS).not.toContain("github")
  })

  it("native adapter registry platforms are exposed as stable", () => {
    const stableSet = new Set(
      CONNECTOR_METADATA.filter((m) => m.status === "stable").map((m) => m.type)
    )
    expect(stableSet).toEqual(
      new Set([
        "telegram",
        "discord",
        "slack",
        "lark",
        "onebot",
        "wecom",
        "wechat-personal",
        "matrix",
        "qq-official",
        "wechat-oa",
        "dingtalk",
      ])
    )
  })

  it("native rich-capable adapter metadata exposes rich message support", () => {
    for (const kind of [
      "matrix",
      "wecom",
      "dingtalk",
      "telegram",
      "discord",
      "slack",
      "lark",
    ] as const) {
      expect(getConnectorMeta(kind)).toMatchObject({ status: "stable", richMessages: true })
    }
  })

  it("stable text-only adapters do not overclaim rich outbound support", () => {
    for (const kind of ["qq-official", "wechat-oa"] as const) {
      expect(getConnectorMeta(kind)).toMatchObject({ status: "stable", richMessages: false })
    }
  })

  it("reply-only personal WeChat is stable without rich outbound claims", () => {
    expect(getConnectorMeta("wechat-personal")).toMatchObject({
      status: "stable",
      oauth: false,
      richMessages: false,
    })
  })

  it("dingtalk does not claim OAuth (appKey/appSecret keyring config only)", () => {
    expect(getConnectorMeta("dingtalk")).toMatchObject({
      status: "stable",
      oauth: false,
      richMessages: true,
    })
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
