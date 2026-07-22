import { ALL_PLATFORM_KINDS } from "./platform-kind"
import {
  builtInConnectorRuntimeCapabilities,
  connectorRuntimeCapabilitiesForScope,
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
})
