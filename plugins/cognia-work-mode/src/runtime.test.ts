import type { Artifact } from "@cognia/plugin-sdk"
import type { PluginSubagentDispatchResult } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import {
  createWorkRuntime,
  MAX_REVIEW_CONTENT_CHARS,
  parseReviewStatus,
  reviewPrompt,
  type WorkPluginContext,
} from "./runtime"

type Locale = keyof typeof manifestJson.i18n.locales

/** `ctx.i18n.t` over the plugin's own bundle, failing loudly on a missing key. */
function translator(locale: Locale = "en") {
  const bundle = manifestJson.i18n.locales[locale] as Record<string, string>
  return (key: string, params?: Record<string, string | number>) => {
    const value = bundle[key]
    if (value === undefined) throw new Error(`missing ${locale} key ${key}`)
    return value.replace(/\{(\w+)\}/g, (match, name: string) =>
      params?.[name] !== undefined ? String(params[name]) : match
    )
  }
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    sessionId: "session-1",
    messageId: "message-1",
    type: "document",
    title: "Quarterly brief",
    content: "# Quarterly brief\n\nEvidence-backed draft.",
    language: "markdown",
    version: 1,
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    updatedAt: new Date("2026-07-22T00:00:00.000Z"),
    ...overrides,
  }
}

function makeContext(locale: Locale = "en") {
  const artifacts = new Map<string, Artifact>()
  const createArtifact = jest.fn(
    async (input: Parameters<WorkPluginContext["artifact"]["createArtifact"]>[0]) => {
      const id = `artifact-${artifacts.size + 1}`
      artifacts.set(
        id,
        makeArtifact({
          id,
          sessionId: input.sessionId ?? "",
          messageId: input.messageId ?? "",
          title: input.title,
          content: input.content,
          type: input.type === "text" ? "document" : (input.type ?? "code"),
          language: input.language,
          metadata: input.metadata,
        })
      )
      return id
    }
  )
  const openArtifact = jest.fn()
  const dispatchSubagent = jest.fn(
    async (id: string, prompt: string): Promise<PluginSubagentDispatchResult> => ({
      text: `${id}: ${prompt.slice(0, 24)}`,
      channel: "text",
      toolsAvailable: false,
      runId: `${id}-run`,
    })
  )
  const invokeDependencyTool = jest.fn(
    async (
      _dependencyId: string,
      _toolName: string,
      _args: Record<string, unknown>,
      _options?: { sessionId?: string; messageId?: string }
    ): Promise<{ ok: boolean; artifactId?: string }> => ({
      ok: true,
      artifactId: "office-artifact-1",
    })
  )
  const ctx = {
    pluginId: "cognia-work-mode",
    artifact: {
      createArtifact,
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact,
    },
    agent: { dispatchSubagent, invokeDependencyTool },
    i18n: { t: translator(locale) },
  } as unknown as WorkPluginContext

  return { artifacts, createArtifact, ctx, dispatchSubagent, invokeDependencyTool, openArtifact }
}

describe("WorkRuntime", () => {
  it.each([
    ["document", "text", "markdown", "markdown"],
    ["report", "text", "markdown", "markdown"],
    ["presentation", "html", "html", "html"],
    ["site", "html", "html", "html"],
  ] as const)("creates and reveals a %s deliverable", async (kind, type, language, format) => {
    const { createArtifact, ctx, openArtifact } = makeContext()
    const runtime = createWorkRuntime(ctx)

    const result = await runtime.createDeliverable({
      kind,
      title: "Outcome",
      content: "finished work",
      sessionId: "session-1",
      messageId: "message-1",
    })

    expect(result).toEqual({ ok: true, artifactId: "artifact-1", kind, format })
    expect(createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Outcome",
        content: "finished work",
        type,
        language,
        sessionId: "session-1",
        messageId: "message-1",
      })
    )
    expect(openArtifact).toHaveBeenCalledWith("artifact-1")
  })

  it("rejects empty deliverables before touching the artifact store", async () => {
    const { createArtifact, ctx } = makeContext()

    await expect(
      createWorkRuntime(ctx).createDeliverable({ kind: "document", title: " ", content: "x" })
    ).rejects.toThrow("title")
    await expect(
      createWorkRuntime(ctx).createDeliverable({ kind: "document", title: "x", content: " " })
    ).rejects.toThrow("content")
    expect(createArtifact).not.toHaveBeenCalled()
  })

  it("reviews a deliverable and creates a linked review artifact", async () => {
    const { artifacts, ctx, dispatchSubagent, openArtifact } = makeContext()
    artifacts.set("source-1", makeArtifact({ id: "source-1" }))

    const result = await createWorkRuntime(ctx).reviewDeliverable(
      {
        artifactId: "source-1",
        criteria: ["accurate", "decision-ready"],
        sessionId: "session-1",
        messageId: "message-2",
      },
      { signal: new AbortController().signal }
    )

    expect(dispatchSubagent).toHaveBeenCalledWith(
      "cognia-work-mode:deliverable-reviewer",
      expect.stringContaining("accurate"),
      expect.objectContaining({ toolsEnabled: false, abortSignal: expect.any(AbortSignal) })
    )
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        artifactId: "source-1",
        reviewArtifactId: "artifact-2",
      })
    )
    expect(artifacts.get("artifact-2")).toMatchObject({
      type: "document",
      title: "Review — Quarterly brief",
      metadata: { derivedFromArtifactId: "source-1", sourceOrigin: "tool" },
    })
    expect(result.truncated).toBe(false)
    expect(openArtifact).toHaveBeenLastCalledWith("artifact-2")
  })

  it("names the review artifact in the user's language", async () => {
    const { artifacts, ctx } = makeContext("zh-CN")
    artifacts.set("source-1", makeArtifact({ id: "source-1" }))
    await createWorkRuntime(ctx).reviewDeliverable({ artifactId: "source-1" })
    expect(artifacts.get("artifact-2")?.title).toBe("审阅 — Quarterly brief")
  })

  it("caps the deliverable a review puts into one prompt", async () => {
    const { artifacts, ctx, dispatchSubagent } = makeContext()
    const huge = "x".repeat(MAX_REVIEW_CONTENT_CHARS + 5_000)
    artifacts.set("source-1", makeArtifact({ id: "source-1", content: huge }))

    const result = await createWorkRuntime(ctx).reviewDeliverable({ artifactId: "source-1" })

    const prompt = dispatchSubagent.mock.calls[0][1] as string
    expect(prompt.length).toBeLessThan(MAX_REVIEW_CONTENT_CHARS + 2_000)
    expect(prompt).toContain(`Only the first ${MAX_REVIEW_CONTENT_CHARS}`)
    expect(result.truncated).toBe(true)
  })

  it("leaves a deliverable under the cap whole", () => {
    const { prompt, truncated } = reviewPrompt(makeArtifact(), ["accurate"])
    expect(truncated).toBe(false)
    expect(prompt).toContain("Evidence-backed draft.")
    expect(prompt).not.toContain("Only the first")
  })

  it("ships every en message in zh-CN", () => {
    expect(Object.keys(manifestJson.i18n.locales["zh-CN"]).sort()).toEqual(
      Object.keys(manifestJson.i18n.locales.en).sort()
    )
  })

  it("fails clearly when a review target does not exist", async () => {
    const { ctx, dispatchSubagent } = makeContext()

    await expect(
      createWorkRuntime(ctx).reviewDeliverable({ artifactId: "missing" })
    ).rejects.toThrow('artifact "missing" was not found')
    expect(dispatchSubagent).not.toHaveBeenCalled()
  })

  it("updates an existing deliverable without dropping unrelated fields", async () => {
    const { artifacts, ctx, openArtifact } = makeContext()
    const updateArtifact = jest.fn((id: string, updates: Partial<Artifact>) => {
      const current = artifacts.get(id)
      if (current) artifacts.set(id, { ...current, ...updates })
      return artifacts.get(id)!
    })
    ctx.artifact.updateArtifact = updateArtifact
    artifacts.set(
      "source-1",
      makeArtifact({ id: "source-1", metadata: { sourceOrigin: "tool", wordCount: 3 } })
    )

    const result = createWorkRuntime(ctx).updateDeliverable({
      artifactId: "source-1",
      title: "Revised quarterly brief",
      content: "Revised evidence-backed draft.",
    })

    expect(result).toEqual({ ok: true, artifactId: "source-1" })
    expect(updateArtifact).toHaveBeenCalledWith("source-1", {
      title: "Revised quarterly brief",
      content: "Revised evidence-backed draft.",
      expectedVersion: 1,
      changeDescription: "Updated by Work Mode",
    })
    expect(artifacts.get("source-1")?.metadata).toEqual({ sourceOrigin: "tool", wordCount: 3 })
    expect(openArtifact).toHaveBeenCalledWith("source-1")
  })

  it("requires update content and preserves omitted artifact ownership fields", async () => {
    const { artifacts, createArtifact, ctx } = makeContext()
    artifacts.set("source-1", makeArtifact({ id: "source-1" }))

    expect(() => createWorkRuntime(ctx).updateDeliverable({ artifactId: "source-1" })).toThrow(
      "at least one"
    )
    await createWorkRuntime(ctx).createDeliverable({
      kind: "document",
      title: "Standalone",
      content: "Content",
    })
    expect(createArtifact).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything(), messageId: expect.anything() })
    )
  })

  it("uses default review criteria and validates explicit criteria and reviewer output", async () => {
    const { artifacts, ctx, dispatchSubagent } = makeContext()
    artifacts.set("source-1", makeArtifact({ id: "source-1" }))
    const runtime = createWorkRuntime(ctx)

    await runtime.reviewDeliverable({ artifactId: "source-1" })
    expect(dispatchSubagent).toHaveBeenCalledWith(
      "cognia-work-mode:deliverable-reviewer",
      expect.stringContaining("correct and source-supported"),
      { toolsEnabled: false }
    )
    await expect(
      runtime.reviewDeliverable({ artifactId: "source-1", criteria: [] })
    ).rejects.toThrow("at least one")
    await expect(
      runtime.reviewDeliverable({ artifactId: "source-1", criteria: [" "] })
    ).rejects.toThrow("criteria[0]")

    dispatchSubagent.mockResolvedValueOnce({
      text: " ",
      channel: "text",
      toolsAvailable: false,
      runId: "empty-review",
    })
    await expect(runtime.reviewDeliverable({ artifactId: "source-1" })).rejects.toThrow(
      "review result"
    )
  })

  it("dispatches independent specialist tasks concurrently and preserves input order", async () => {
    const { ctx, dispatchSubagent } = makeContext()
    const reportProgress = jest.fn()

    const result = await createWorkRuntime(ctx).runParallel(
      {
        tasks: [
          { role: "researcher", prompt: "Find primary sources" },
          { role: "analyst", prompt: "Analyze the supplied numbers" },
          { role: "deliverable-reviewer", prompt: "Challenge the conclusion" },
        ],
      },
      { reportProgress }
    )

    expect(dispatchSubagent).toHaveBeenNthCalledWith(
      1,
      "cognia-work-mode:researcher",
      "Find primary sources",
      expect.objectContaining({ toolsEnabled: true })
    )
    expect(dispatchSubagent).toHaveBeenNthCalledWith(
      2,
      "cognia-work-mode:analyst",
      "Analyze the supplied numbers",
      expect.objectContaining({ toolsEnabled: false })
    )
    expect(result.results.map((entry) => entry.role)).toEqual([
      "researcher",
      "analyst",
      "deliverable-reviewer",
    ])
    expect(reportProgress).toHaveBeenLastCalledWith(100, "3/3 specialist tasks complete")
  })

  it("delegates spreadsheet deliverables to the cognia-office dependency", async () => {
    const { createArtifact, ctx, invokeDependencyTool } = makeContext()
    const result = await createWorkRuntime(ctx).createDeliverable({
      kind: "spreadsheet",
      title: "Inventory",
      content: "SKU,Qty\nA-1,4",
      sessionId: "session-1",
      messageId: "message-1",
    })
    expect(result).toEqual({
      ok: true,
      artifactId: "office-artifact-1",
      kind: "spreadsheet",
      format: "xlsx",
    })
    expect(invokeDependencyTool).toHaveBeenCalledWith(
      "cognia-office",
      "office_create_workbook",
      { title: "Inventory", content: "SKU,Qty\nA-1,4" },
      { sessionId: "session-1", messageId: "message-1" }
    )
    expect(createArtifact).not.toHaveBeenCalled()
  })

  it("fails closed when Office does not return an artifact and routes workbook edits to Office", async () => {
    const { artifacts, ctx, invokeDependencyTool } = makeContext()
    invokeDependencyTool.mockResolvedValueOnce({ ok: false })
    await expect(
      createWorkRuntime(ctx).createDeliverable({
        kind: "spreadsheet",
        title: "Inventory",
        content: "SKU,Qty",
      })
    ).rejects.toThrow("did not return a workbook artifact")

    artifacts.set(
      "office-1",
      makeArtifact({
        id: "office-1",
        metadata: {
          plugin: {
            kind: "cognia-office/workbook",
            schemaVersion: 1,
            ownerPluginId: "cognia-office",
          },
        },
      })
    )
    expect(() =>
      createWorkRuntime(ctx).updateDeliverable({ artifactId: "office-1", content: "plaintext" })
    ).toThrow(
      "this workbook belongs to cognia-office; edit it with office_apply_operations (read it with office_read_range)"
    )
  })

  it("bounds parallel fan-out and validates every task", async () => {
    const { ctx, dispatchSubagent } = makeContext()
    const runtime = createWorkRuntime(ctx)

    await expect(runtime.runParallel({ tasks: [] })).rejects.toThrow("between 1 and 4")
    await expect(
      runtime.runParallel({
        tasks: Array.from({ length: 5 }, (_, index) => ({
          role: "researcher" as const,
          prompt: `task ${index}`,
        })),
      })
    ).rejects.toThrow("between 1 and 4")
    await expect(
      runtime.runParallel({ tasks: [{ role: "analyst", prompt: " " }] })
    ).rejects.toThrow("prompt")
    expect(dispatchSubagent).not.toHaveBeenCalled()
  })

  it("threads cwd/cancellation and records specialist failures without rejecting the batch", async () => {
    const { ctx, dispatchSubagent } = makeContext()
    dispatchSubagent
      .mockResolvedValueOnce({
        text: "research",
        channel: "text",
        toolsAvailable: true,
        errorEnvelope: {
          code: "unknown",
          retryable: false,
          message: "partial source failure",
        },
      })
      .mockRejectedValueOnce(new Error("analysis failed"))
      .mockRejectedValueOnce("review failed")
    const signal = new AbortController().signal

    const result = await createWorkRuntime(ctx).runParallel(
      {
        cwd: "/workspace",
        tasks: [
          { role: "researcher", prompt: "Research" },
          { role: "analyst", prompt: "Analyze" },
          { role: "deliverable-reviewer", prompt: "Review" },
        ],
      },
      { signal }
    )

    expect(dispatchSubagent).toHaveBeenNthCalledWith(
      1,
      "cognia-work-mode:researcher",
      "Research",
      expect.objectContaining({ cwd: "/workspace", abortSignal: signal, toolsEnabled: true })
    )
    expect(result.results).toEqual([
      expect.objectContaining({ text: "research", error: "partial source failure" }),
      expect.objectContaining({ text: "", error: "analysis failed" }),
      expect.objectContaining({ text: "", error: "review failed" }),
    ])
  })

  it("writes a DOCX document through cognia-documents and relays its conversion notes", async () => {
    const { createArtifact, ctx, invokeDependencyTool } = makeContext()
    invokeDependencyTool.mockResolvedValueOnce({
      ok: true,
      artifactId: "doc-1",
      conversionNotes: ['Links were kept as "text (url)".'],
    } as never)
    const result = await createWorkRuntime(ctx).createDeliverable({
      kind: "report",
      format: "docx",
      title: "Board memo",
      content: "# Decision\n\nApprove [plan](https://x.dev).",
      sessionId: "session-1",
    })
    expect(result).toEqual({
      ok: true,
      artifactId: "doc-1",
      kind: "report",
      format: "docx",
      conversionNotes: ['Links were kept as "text (url)".'],
    })
    expect(invokeDependencyTool).toHaveBeenCalledWith(
      "cognia-documents",
      "documents_create",
      { title: "Board memo", markdown: "# Decision\n\nApprove [plan](https://x.dev)." },
      { sessionId: "session-1" }
    )
    expect(createArtifact).not.toHaveBeenCalled()
  })

  it("rejects a format the deliverable kind cannot be written in", async () => {
    const { createArtifact, ctx, invokeDependencyTool } = makeContext()
    await expect(
      createWorkRuntime(ctx).createDeliverable({
        kind: "spreadsheet",
        format: "docx",
        title: "x",
        content: "a,b",
      })
    ).rejects.toThrow("a spreadsheet deliverable cannot be docx; use xlsx")
    expect(invokeDependencyTool).not.toHaveBeenCalled()
    expect(createArtifact).not.toHaveBeenCalled()
  })

  it("routes DOCX edits to cognia-documents instead of overwriting the model", () => {
    const { artifacts, ctx } = makeContext()
    artifacts.set(
      "doc-1",
      makeArtifact({
        id: "doc-1",
        metadata: {
          plugin: {
            kind: "cognia-documents/document",
            schemaVersion: 1,
            ownerPluginId: "cognia-documents",
          },
        },
      })
    )
    expect(() =>
      createWorkRuntime(ctx).updateDeliverable({ artifactId: "doc-1", title: "Renamed" })
    ).toThrow("edit it with documents_apply_operations (read it with documents_read_markdown)")
  })

  it("reviews native deliverables as their dependency's text, not their JSON model", async () => {
    const { artifacts, ctx, dispatchSubagent, invokeDependencyTool } = makeContext()
    artifacts.set(
      "office-1",
      makeArtifact({
        id: "office-1",
        title: "Inventory",
        content: '{"schemaVersion":1,"sheets":[]}',
        metadata: {
          plugin: {
            kind: "cognia-office/workbook",
            schemaVersion: 1,
            ownerPluginId: "cognia-office",
          },
        },
      })
    )
    invokeDependencyTool.mockResolvedValueOnce({
      ok: true,
      text: "## Stock (A1:B2)\nSKU\tQty\nA-1\t4",
      truncated: true,
    } as never)
    dispatchSubagent.mockResolvedValueOnce({
      text: "Blocking: none.\n\nPASS WITH CAVEATS",
      channel: "text",
      toolsAvailable: false,
    })
    const signal = new AbortController().signal
    const result = await createWorkRuntime(ctx).reviewDeliverable(
      { artifactId: "office-1" },
      { signal }
    )
    expect(invokeDependencyTool).toHaveBeenCalledWith(
      "cognia-office",
      "office_read_range",
      { artifactId: "office-1", format: "text", maxCells: 20_000 },
      { signal }
    )
    const prompt = dispatchSubagent.mock.calls[0][1]
    expect(prompt).toContain('Review the deliverable "Inventory" (workbook)')
    expect(prompt).toContain("SKU\tQty")
    expect(prompt).not.toContain("schemaVersion")
    expect(prompt).toContain("too large to read in full")
    expect(result).toMatchObject({ status: "pass-with-caveats", truncated: true })
  })

  it("reviews a DOCX document as Markdown", async () => {
    const { artifacts, ctx, dispatchSubagent, invokeDependencyTool } = makeContext()
    artifacts.set(
      "doc-1",
      makeArtifact({
        id: "doc-1",
        metadata: {
          plugin: {
            kind: "cognia-documents/document",
            schemaVersion: 1,
            ownerPluginId: "cognia-documents",
          },
        },
      })
    )
    invokeDependencyTool.mockResolvedValueOnce({ ok: true, markdown: "# Memo\n\nBody" } as never)
    const result = await createWorkRuntime(ctx).reviewDeliverable({ artifactId: "doc-1" })
    expect(invokeDependencyTool).toHaveBeenCalledWith(
      "cognia-documents",
      "documents_read_markdown",
      { artifactId: "doc-1" },
      {}
    )
    expect(dispatchSubagent.mock.calls[0][1]).toContain("(document)")
    expect(dispatchSubagent.mock.calls[0][1]).toContain("# Memo\n\nBody")
    expect(result.truncated).toBe(false)
  })

  it("fails a native review clearly when the dependency returns no text", async () => {
    const { artifacts, ctx, dispatchSubagent, invokeDependencyTool } = makeContext()
    artifacts.set(
      "doc-1",
      makeArtifact({
        id: "doc-1",
        metadata: {
          plugin: {
            kind: "cognia-documents/document",
            schemaVersion: 1,
            ownerPluginId: "cognia-documents",
          },
        },
      })
    )
    invokeDependencyTool.mockResolvedValueOnce({ ok: true } as never)
    await expect(createWorkRuntime(ctx).reviewDeliverable({ artifactId: "doc-1" })).rejects.toThrow(
      "dependency read returned no markdown"
    )
    expect(dispatchSubagent).not.toHaveBeenCalled()
  })
})

describe("parseReviewStatus", () => {
  it.each([
    ["Findings…\n\nPASS", "pass"],
    ["Blocking: one.\n\nREVISE", "revise"],
    ["Earlier I considered REVISE.\n\nFinal: PASS WITH CAVEATS", "pass-with-caveats"],
    ["These checks pass, looks fine.", "unknown"],
  ] as const)("reads %j as %s", (text, status) => {
    expect(parseReviewStatus(text)).toBe(status)
  })
})
