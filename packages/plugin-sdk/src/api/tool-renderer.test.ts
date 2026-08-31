import * as toolRenderer from "./tool-renderer"

describe("tool-renderer author surface", () => {
  it("parses object and JSON outputs while rejecting other values", () => {
    const object = { ok: true }
    expect(toolRenderer.parseOutputJson(object)).toBe(object)
    expect(toolRenderer.parseOutputJson('{"ok":true}')).toEqual(object)
    expect(toolRenderer.parseOutputJson(" ")).toBeNull()
    expect(toolRenderer.parseOutputJson("not-json")).toBeNull()
    expect(toolRenderer.parseOutputJson(42)).toBeNull()
  })

  it("builds media URLs from both MCP wire shapes", () => {
    expect(
      toolRenderer.blockMediaSrc(
        { type: "image", data: "AAA", mimeType: "image/png" },
        "application/octet-stream"
      )
    ).toBe("data:image/png;base64,AAA")
    expect(
      toolRenderer.blockMediaSrc(
        { type: "image", source: { data: "BBB", media_type: "image/jpeg" } },
        "application/octet-stream"
      )
    ).toBe("data:image/jpeg;base64,BBB")
    expect(
      toolRenderer.blockMediaSrc({ type: "image", data: "data:image/webp;base64,CCC" }, "image/png")
    ).toBe("data:image/webp;base64,CCC")
    expect(toolRenderer.blockMediaSrc({ type: "text", text: "x" }, "image/png")).toBeNull()
  })

  it("keeps URL and language helpers portable", () => {
    expect(toolRenderer.hostOf("https://docs.cognia.dev/plugins")).toBe("docs.cognia.dev")
    expect(toolRenderer.hostOf("not a URL")).toBe("not a URL")
    expect(toolRenderer.languageFromPath("plugin.tsx")).toBe("tsx")
    expect(toolRenderer.languageFromPath("LICENSE")).toBe("text")
    expect(toolRenderer.languageFromPath(undefined)).toBe("text")
  })

  it("does not expose host registries, host components, or host hooks", () => {
    expect(toolRenderer).not.toHaveProperty("registerToolResultRenderer")
    expect(toolRenderer).not.toHaveProperty("McpCardShell")
    expect(toolRenderer).not.toHaveProperty("ImageBlock")
    expect(toolRenderer).not.toHaveProperty("useCopy")
  })
})
