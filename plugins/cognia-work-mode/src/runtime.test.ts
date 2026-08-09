import type { Artifact } from "@/types/artifact"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"
import { createWorkRuntime, type WorkPluginContext } from "./runtime"

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

function makeContext() {
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
  } as unknown as WorkPluginContext

  return { artifacts, createArtifact, ctx, dispatchSubagent, invokeDependencyTool, openArtifact }
}

describe("WorkRuntime", () => {
  it.each([
    ["document", "text", "markdown"],
    ["report", "text", "markdown"],
    ["presentation", "html", "html"],
    ["site", "html", "html"],
  ] as const)("creates and reveals a %s deliverable", async (kind, type, language) => {
    const { createArtifact, ctx, openArtifact } = makeContext()
    const runtime = createWorkRuntime(ctx)

    const result = await runtime.createDeliverable({
      kind,
      title: "Outcome",
      content: "finished work",
      sessionId: "session-1",
      messageId: "message-1",
    })

    expect(result).toEqual({ ok: true, artifactId: "artifact-1", kind })
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
      metadata: { derivedFromArtifactId: "source-1", sourceOrigin: "tool" },
    })
    expect(openArtifact).toHaveBeenLastCalledWith("artifact-2")
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
    expect(result).toEqual({ ok: true, artifactId: "office-artifact-1", kind: "spreadsheet" })
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
    ).toThrow("must use cognia-office workbook operations")
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
})
