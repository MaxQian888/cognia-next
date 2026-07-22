import { ALL_PLATFORM_KINDS } from "./platform-kind"
import { builtInConnectorRuntimeCapabilities } from "./runtime-capability"

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

  it("declares rich Lark topic/CardKit support without claiming live steer", () => {
    expect(builtInConnectorRuntimeCapabilities("lark")).toMatchObject({
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      liveSteer: false,
      textStreaming: true,
      componentMutation: true,
      fullReplacement: true,
      followUpBubbles: true,
      ambiguousDelivery: "remote_idempotent",
    })
  })

  it("does not silently claim topic isolation for channel-only adapters", () => {
    for (const platform of ["onebot", "dingtalk", "matrix", "wecom"] as const) {
      expect(builtInConnectorRuntimeCapabilities(platform).topicIsolation).toBe("unsupported")
    }
  })
})
