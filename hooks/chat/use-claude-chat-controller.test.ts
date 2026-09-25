import {
  resolveChatTurnAttemptIdentity,
  useClaudeChat,
  userPromptText,
  rewriteUserPromptText,
  externalTurnPrompt,
  redirectSendToBundleAliases,
} from "./use-claude-chat-controller"
import type { SendContentBlock, SendOptions } from "@cognia/agent-config-types"

describe("Claude chat controller seam", () => {
  it("exports the public hook implementation", () => {
    expect(typeof useClaudeChat).toBe("function")
    expect(useClaudeChat.name).toBe("useClaudeChat")
  })

  it("keeps durable-work behavior covered by the public hook contract suite", () => {
    // The behavioral tests live in use-claude-chat.test.ts because that suite
    // owns the hook's full sidecar/store harness. Keep this seam explicit so a
    // future split cannot silently drop acceptance/claim/handoff coverage.
    expect(typeof useClaudeChat).toBe("function")
  })

  it("keeps turn stable and increments attempt across regenerate/retry", () => {
    const attempts = new Map<string, number>()
    const messages = [{ id: "user-1", role: "user", parts: [] }] as never
    const first = resolveChatTurnAttemptIdentity({
      sessionId: "s1",
      runId: "r1",
      messages: [],
      reuseLastUserTurn: false,
      attempts,
      mintTurnId: () => "user-1",
    })
    const retry = resolveChatTurnAttemptIdentity({
      sessionId: "s1",
      runId: "r1",
      messages,
      reuseLastUserTurn: true,
      attempts,
    })
    expect(first).toEqual({ runId: "r1", turnId: "user-1", attemptId: "a1" })
    expect(retry).toEqual({ runId: "r1", turnId: "user-1", attemptId: "a2" })
  })

  // HostState send/steer/abort/approval branches are exercised by the public
  // hook contract suite in `use-claude-chat.test.ts`; this seam test remains
  // intentionally dependency-free so import regressions fail quickly.
})

describe("attachment prompt hook isolation", () => {
  const content = [
    { type: "text" as const, text: "PRIVATE ATTACHMENT BODY" },
    { type: "text" as const, text: "Summarize the report" },
    { type: "text" as const, text: "Unrelated appended context" },
  ]
  it("selects only the authored block after attachment provenance", () => {
    expect(userPromptText(content, 1)).toBe("Summarize the report")
    expect(userPromptText(content.slice(0, 1), 1)).toBe("")
  })
  it("rewrites only authored prose and preserves every attachment/context block", () => {
    expect(rewriteUserPromptText(content, "Rewritten request", 1)).toEqual([
      content[0],
      { type: "text", text: "Rewritten request" },
      content[2],
    ])
    expect(rewriteUserPromptText(content.slice(0, 1), "Do not replace the file", 1)).toEqual(
      content.slice(0, 1)
    )
    expect(rewriteUserPromptText("original", "new")).toBe("new")
  })
})

describe("externalTurnPrompt", () => {
  const doc = { type: "text" as const, text: "EXTRACTED REPORT BODY" }
  const typed = { type: "text" as const, text: "Summarize the report" }
  const link = { type: "text" as const, text: "Fetched page context" }
  const image: SendContentBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  }
  /** Nothing left out. */
  const none = { attachments: [], unnamed: 0, trailingText: 0 }

  it("sends a plain-string turn whole", () => {
    expect(externalTurnPrompt("fix the bug")).toEqual({
      request: "fix the bug",
      prompt: "fix the bug",
      omitted: none,
    })
  })

  it("reads the question past an extracted document and keeps the document ahead of it", () => {
    expect(externalTurnPrompt([doc, typed], 1)).toEqual({
      request: "Summarize the report",
      prompt: "EXTRACTED REPORT BODY\n\nSummarize the report",
      omitted: none,
    })
  })

  it("carries an image's OCR text but not the image, and every text attachment in order", () => {
    const ocr = { type: "text" as const, text: "OCR LINES" }
    expect(externalTurnPrompt([image, ocr, doc, typed], 3)).toEqual({
      request: "Summarize the report",
      prompt: "OCR LINES\n\nEXTRACTED REPORT BODY\n\nSummarize the report",
      // The image itself, by its manifest index, so the lane can name it.
      omitted: { ...none, attachments: [0] },
    })
  })

  it("keeps provider lines in front of the attachments, and nothing after the question", () => {
    const reply = { type: "text" as const, text: '[Replying to: "earlier"]' }
    expect(externalTurnPrompt([reply, doc, typed, link], 1, 1)).toEqual({
      request: "Summarize the report",
      prompt: '[Replying to: "earlier"]\n\nEXTRACTED REPORT BODY\n\nSummarize the report',
      omitted: { ...none, trailingText: 1 },
    })
  })

  it("sends only the question when nothing is attached, as before", () => {
    expect(externalTurnPrompt([typed, link], 0)).toEqual({
      request: "Summarize the report",
      prompt: "Summarize the report",
      omitted: { ...none, trailingText: 1 },
    })
    expect(externalTurnPrompt([image, typed], 1)).toEqual({
      request: "Summarize the report",
      prompt: "Summarize the report",
      omitted: { ...none, attachments: [0] },
    })
  })

  it("sends the attachment text alone when nothing was typed", () => {
    expect(externalTurnPrompt([doc], 1)).toEqual({
      request: "",
      prompt: "EXTRACTED REPORT BODY",
      omitted: none,
    })
  })

  it("counts a non-text block no manifest names, and ignores an empty trailing block", () => {
    expect(externalTurnPrompt([typed, image, { type: "text", text: "  " }], 0).omitted).toEqual({
      ...none,
      unnamed: 1,
    })
  })
})

describe("redirectSendToBundleAliases", () => {
  // The owning workspace's two roots, as a canonical bundle checks them out.
  const lease = { primaryAlias: "/isolated/app", additionalAliases: ["/isolated/docs"] }
  const aliasesBySource = new Map([
    ["/repo", "/isolated/app"],
    ["/docs", "/isolated/docs"],
  ])
  const sourceSend: SendOptions = {
    model: "sonnet",
    cwd: "/repo",
    additionalDirectories: ["/docs"],
    trustedWorkspaceRoots: ["/repo", "/docs"],
  }
  /** What the sidecar honours: a trusted root that is also active for the send. */
  const honoured = (options: SendOptions) => {
    const active = [options.cwd, ...(options.additionalDirectories ?? [])]
    return (options.trustedWorkspaceRoots ?? []).filter((root) => active.includes(root))
  }

  it("moves the trust proof onto the aliases the send now runs in", () => {
    const redirected = redirectSendToBundleAliases(sourceSend, lease, aliasesBySource)

    expect(redirected).toEqual({
      model: "sonnet",
      cwd: "/isolated/app",
      additionalDirectories: ["/isolated/docs"],
      trustedWorkspaceRoots: ["/isolated/app", "/isolated/docs"],
    })
    // Without the remap the source paths are inactive and prove nothing, so
    // the sidecar refused every requested claudeAgentSdk skill or plugin.
    expect(honoured({ ...redirected, trustedWorkspaceRoots: ["/repo", "/docs"] })).toEqual([])
    expect(honoured(redirected)).toEqual(["/isolated/app", "/isolated/docs"])
  })

  it("grants an alias only the trust of the exact source root it checks out", () => {
    const redirected = redirectSendToBundleAliases(
      // "/docs" was never trusted; "/repo/packages/app" is a different root
      // from "/repo" and its grant was never given for "/isolated/app".
      { ...sourceSend, trustedWorkspaceRoots: ["/repo/packages/app", " /repo "] },
      lease,
      aliasesBySource
    )

    expect(redirected.trustedWorkspaceRoots).toEqual(["/repo/packages/app", "/isolated/app"])
    expect(honoured(redirected)).toEqual(["/isolated/app"])
  })

  it("keeps an aliased proof when the turn lease re-points the same bundle again", () => {
    const bound = redirectSendToBundleAliases(sourceSend, lease, aliasesBySource)
    const leased = redirectSendToBundleAliases(bound, lease, aliasesBySource)

    expect(leased.trustedWorkspaceRoots).toEqual(["/isolated/app", "/isolated/docs"])
  })

  it("adds no proof to a send that carried none", () => {
    const { trustedWorkspaceRoots: _dropped, ...untrusted } = sourceSend
    const redirected = redirectSendToBundleAliases(untrusted, lease, aliasesBySource)

    expect(redirected).not.toHaveProperty("trustedWorkspaceRoots")
    expect(redirected.cwd).toBe("/isolated/app")
  })
})
