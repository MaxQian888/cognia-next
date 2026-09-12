import type { PluginContext } from "@cognia/plugin-sdk"

import { persistReport } from "./artifacts"
import type { DeepResearchResult } from "./types"

const report: DeepResearchResult = {
  topic: "topic",
  title: "The Report",
  report: "# The Report\n\nBody with several words.\n\n## Sources\n1. [A](https://a.test)",
  outline: { title: "The Report", sections: [{ heading: "H", question: "Q" }] },
  sections: [{ heading: "H", question: "Q", answer: "A", citations: [], gaveUp: false, steps: 3 }],
  citations: [{ url: "https://a.test", title: "A" }],
  usage: { totalTokens: 100 },
  gaveUp: false,
}

function ctx(artifact?: Partial<PluginContext["artifact"]>): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    artifact,
    logger: { info: jest.fn(), warn: jest.fn() },
  } as unknown as PluginContext
}

describe("persistReport", () => {
  it("saves the report as a plugin-owned markdown document and returns the id", async () => {
    const createArtifact = jest.fn(async () => "art-1")
    const id = await persistReport(ctx({ createArtifact }), report, {
      sessionId: "s-1",
      messageId: "m-1",
    })
    expect(id).toBe("art-1")
    expect(createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "The Report",
        type: "document",
        language: "markdown",
        kind: "report",
        schemaVersion: 1,
        sessionId: "s-1",
        messageId: "m-1",
        metadata: expect.objectContaining({
          sourceOrigin: "tool",
          userInitiated: true,
          exportFormats: ["raw", "html", "pdf"],
        }),
      })
    )
    expect(createArtifact.mock.calls[0][0].metadata?.wordCount).toBeGreaterThan(0)
  })

  it("returns undefined instead of throwing when the host cannot save", async () => {
    // A missing `artifact:write` grant or a host without the artifact surface
    // must not downgrade a completed run into an error.
    const warn = jest.fn()
    const createArtifact = jest.fn(async () => {
      throw new Error("missing permission artifact:write")
    })
    const c = ctx({ createArtifact })
    c.logger.warn = warn
    await expect(persistReport(c, report)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it("omits absent routing keys rather than sending explicit undefined", async () => {
    const createArtifact = jest.fn(async () => "a")
    await persistReport(ctx({ createArtifact }), report)
    const arg = createArtifact.mock.calls[0][0]
    expect(arg).not.toHaveProperty("sessionId")
    expect(arg).not.toHaveProperty("messageId")
  })
})
