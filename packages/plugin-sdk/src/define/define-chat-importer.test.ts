import { defineChatImporter } from "./define-chat-importer"

interface SlackExport {
  channels: Array<{ name: string; messages: Array<{ text: string }> }>
}

describe("defineChatImporter", () => {
  it("returns the importer definition unchanged (pure pass-through)", () => {
    const detect = (d: unknown): d is SlackExport =>
      !!d && typeof d === "object" && Array.isArray((d as SlackExport).channels)
    const parse = jest.fn(async () => [])

    const def = defineChatImporter<SlackExport>({
      format: "slack",
      label: "Slack",
      detect,
      parse,
    })

    expect(def).toMatchObject({ format: "slack", label: "Slack" })
    expect(def.detect).toBe(detect)
    expect(def.parse).toBe(parse)
  })

  it("keeps the bare format id — namespacing is the host's job", () => {
    const def = defineChatImporter({
      format: "discord",
      label: "Discord",
      detect: (d): d is unknown => !!d,
      parse: async () => [],
    })
    // The SDK must NOT pre-namespace; `ctx.import.registerChatImporter` adds
    // the `${pluginId}:` prefix so the plugin cannot choose its own namespace.
    expect(def.format).toBe("discord")
  })
})
