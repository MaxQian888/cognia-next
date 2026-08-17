import { ALL_PLATFORM_KINDS } from "./platform-kind"
import { CONNECTOR_METADATA } from "@/lib/connectors/adapter-metadata"
import {
  builtInConnectorRuntimeCapabilities,
  connectorRuntimeCapabilitiesForScope,
  hasExplicitRuntimeCapabilityOverride,
} from "./runtime-capability"

describe("connector runtime capability matrix", () => {
  it.each(ALL_PLATFORM_KINDS)("returns a complete declaration for %s", (platform) => {
    const matrix = builtInConnectorRuntimeCapabilities(platform)
    expect(Object.keys(matrix).sort()).toEqual(
      [
        "ambiguousDelivery",
        "appendFallback",
        "componentMutation",
        "followUpBubbles",
        "fullReplacement",
        "historyPagination",
        "interactiveControls",
        "liveSteer",
        "messageEditing",
        "staticMenus",
        "suggestedPrompts",
        "textStreaming",
        "topicIsolation",
        "unmentionedDelivery",
      ].sort()
    )
  })

  it("declares rich Lark presentation support and its direct-chat follow-up surface", () => {
    expect(builtInConnectorRuntimeCapabilities("lark")).toMatchObject({
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      liveSteer: true,
      textStreaming: true,
      componentMutation: true,
      fullReplacement: true,
      followUpBubbles: true,
      ambiguousDelivery: "remote_idempotent",
    })
  })

  it("limits Lark follow-up bubbles to private bot chats", () => {
    expect(connectorRuntimeCapabilitiesForScope("lark", "private").followUpBubbles).toBe(true)
    expect(connectorRuntimeCapabilitiesForScope("lark", "group").followUpBubbles).toBe(false)
    expect(connectorRuntimeCapabilitiesForScope("lark", "thread").followUpBubbles).toBe(false)
  })

  it("advertises the shared sidecar live-input bridge independently of platform richness", () => {
    expect(builtInConnectorRuntimeCapabilities("slack").liveSteer).toBe(true)
    expect(builtInConnectorRuntimeCapabilities("onebot").liveSteer).toBe(true)
  })

  it("does not silently claim topic isolation for channel-only adapters", () => {
    for (const platform of ["onebot", "dingtalk", "matrix", "wecom"] as const) {
      expect(builtInConnectorRuntimeCapabilities(platform).topicIsolation).toBe("unsupported")
    }
  })

  it("marks the platforms that carry a per-message idempotency token as remote_idempotent", () => {
    // Lark `uuid`, Matrix `txnId`, Discord `nonce` + enforce_nonce.
    for (const platform of ["lark", "matrix", "discord"] as const) {
      expect(builtInConnectorRuntimeCapabilities(platform).ambiguousDelivery).toBe(
        "remote_idempotent"
      )
    }
    // Everyone else must reconcile after a lost ack.
    for (const platform of [
      "slack",
      "telegram",
      "onebot",
      "wecom",
      "wechat-personal",
      "dingtalk",
      "qq-official",
      "wechat-oa",
    ] as const) {
      expect(builtInConnectorRuntimeCapabilities(platform).ambiguousDelivery).toBe(
        "reconciliation_required"
      )
    }
  })

  it("declares the three previously implicit adapters explicitly", () => {
    expect(builtInConnectorRuntimeCapabilities("dingtalk")).toMatchObject({
      unmentionedDelivery: false,
      ambiguousDelivery: "reconciliation_required",
    })
    expect(builtInConnectorRuntimeCapabilities("qq-official")).toMatchObject({
      unmentionedDelivery: false,
      ambiguousDelivery: "reconciliation_required",
    })
    expect(builtInConnectorRuntimeCapabilities("wechat-oa")).toMatchObject({
      unmentionedDelivery: true,
      ambiguousDelivery: "reconciliation_required",
    })
  })

  it("every shipped (non-planned) platform has an explicit override entry", () => {
    for (const meta of CONNECTOR_METADATA) {
      if (meta.status === "planned") continue
      expect({
        platform: meta.type,
        explicit: hasExplicitRuntimeCapabilityOverride(meta.type),
      }).toEqual({ platform: meta.type, explicit: true })
    }
  })

  it("hasExplicitRuntimeCapabilityOverride is false for planned / unknown kinds", () => {
    expect(hasExplicitRuntimeCapabilityOverride("email")).toBe(false)
    expect(hasExplicitRuntimeCapabilityOverride("kook")).toBe(false)
    expect(hasExplicitRuntimeCapabilityOverride("nope" as never)).toBe(false)
  })
})
