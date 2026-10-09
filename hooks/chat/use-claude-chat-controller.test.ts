jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  persistMessages: jest.fn().mockResolvedValue(undefined),
  persistStreamingMessages: jest.fn().mockResolvedValue(undefined),
}))

import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import {
  createExternalIdleEventConsumer,
  resolveChatTurnAttemptIdentity,
  resolveNativeExternalSessionId,
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

  // Paired sends preserve provider credentials on direct Agent RPC; that behavior
  // and HostState send/steer/abort/approval branches are exercised by the public
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
  const image: Extract<SendContentBlock, { type: "image" }> = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  }
  const video: SendContentBlock = {
    type: "document",
    source: { type: "base64", media_type: "video/mp4", data: "AAAA" },
  }
  /** Nothing left out. */
  const none = { attachments: [], unnamed: 0 }

  it("sends a plain-string turn whole", () => {
    expect(externalTurnPrompt("fix the bug")).toEqual({
      request: "fix the bug",
      prompt: "fix the bug",
      images: [],
      omitted: none,
    })
  })

  it("reads the question past an extracted document and keeps the document ahead of it", () => {
    expect(externalTurnPrompt([doc, typed], 1)).toEqual({
      request: "Summarize the report",
      prompt: "EXTRACTED REPORT BODY\n\nSummarize the report",
      images: [],
      omitted: none,
    })
  })

  it("hands over an image beside its OCR text, by the attachment it came from", () => {
    const ocr = { type: "text" as const, text: "OCR LINES" }
    expect(externalTurnPrompt([image, ocr, doc, typed], 3)).toEqual({
      request: "Summarize the report",
      prompt: "OCR LINES\n\nEXTRACTED REPORT BODY\n\nSummarize the report",
      images: [{ block: image, attachment: 0 }],
      omitted: none,
    })
  })

  it("keeps provider lines in front and the fetched link context after the question", () => {
    const reply = { type: "text" as const, text: '[Replying to: "earlier"]' }
    expect(externalTurnPrompt([reply, doc, typed, link], 1, 1)).toEqual({
      request: "Summarize the report",
      prompt:
        '[Replying to: "earlier"]\n\nEXTRACTED REPORT BODY\n\nSummarize the report\n\nFetched page context',
      images: [],
      omitted: none,
    })
  })

  it("sends the question and its links when nothing is attached", () => {
    expect(externalTurnPrompt([typed, link], 0)).toEqual({
      request: "Summarize the report",
      prompt: "Summarize the report\n\nFetched page context",
      images: [],
      omitted: none,
    })
    expect(externalTurnPrompt([image, typed], 1)).toEqual({
      request: "Summarize the report",
      prompt: "Summarize the report",
      images: [{ block: image, attachment: 0 }],
      omitted: none,
    })
  })

  it("sends the attachment text alone when nothing was typed", () => {
    expect(externalTurnPrompt([doc], 1)).toEqual({
      request: "",
      prompt: "EXTRACTED REPORT BODY",
      images: [],
      omitted: none,
    })
  })

  it("names every frame of a sampled video by its one attachment", () => {
    const caption = { type: "text" as const, text: "Video: clip.mp4, 4 frames" }
    const frame = { ...image, source: { ...image.source, data: "frame" } }
    expect(externalTurnPrompt([caption, frame, frame, typed], 3).images).toEqual([
      { block: frame, attachment: 1 },
      { block: frame, attachment: 2 },
    ])
  })

  it("leaves out only blocks that are neither text nor an image, and ignores empty text", () => {
    expect(externalTurnPrompt([video, typed], 1).omitted).toEqual({ attachments: [0], unnamed: 0 })
    const result = externalTurnPrompt([typed, image, video, { type: "text", text: "  " }], 0)
    expect(result.omitted).toEqual({ attachments: [], unnamed: 1 })
    // An image no manifest names still goes, unnamed.
    expect(result.images).toEqual([{ block: image, attachment: null }])
    expect(result.prompt).toBe("Summarize the report")
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

describe("native external session continuation", () => {
  beforeEach(() => {
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "pi" },
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
    })
  })

  it("continues the selected fork instead of the original tool-host session", () => {
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("chat", { agentId: "pi", sessionId: "forked-native" })
    expect(
      resolveNativeExternalSessionId("chat", "pi", {
        agentId: "pi",
        nativeSessionId: "original-native",
      })
    ).toBe("forked-native")
  })

  it("retains the native lane when the most recent link names a gateway task", () => {
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("chat", { agentId: "pi", sessionId: "cognia-gateway:task:session" })
    expect(
      resolveNativeExternalSessionId("chat", "pi", {
        agentId: "pi",
        nativeSessionId: "original-native",
      })
    ).toBe("original-native")
    expect(
      resolveNativeExternalSessionId("chat", "codex", {
        agentId: "pi",
        nativeSessionId: "original-native",
      })
    ).toBeUndefined()
  })
})

describe("autonomous external turns", () => {
  it("persists delayed output and scopes approval while ignoring ordinary delivery and old links", async () => {
    const { useChatStore } = await import("@/stores/chat/chat-store")
    const messagesDb = await import("@/lib/db/messages")
    const { SessionCoalescingRegistry } = await import("./stream-coalescing")
    const persist = jest.mocked(messagesDb.persistMessages).mockClear()
    const persistStreaming = jest.mocked(messagesDb.persistStreamingMessages).mockClear()
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "pi" },
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
    })
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("idle-chat", { agentId: "pi", sessionId: "native-idle" })
    useChatStore.getState().replaceSessionMessages("idle-chat", [])
    const registry = new SessionCoalescingRegistry({
      onCommit: (id, messages) => useChatStore.getState().replaceSessionMessages(id, messages),
      onPersist: () => {},
      persistDelayMs: 0,
    })
    const consume = createExternalIdleEventConsumer("idle-chat", "pi", "native-idle", registry)
    const base = {
      sessionId: "native-idle",
      timestamp: new Date(),
      delivery: "out_of_band" as const,
    }
    try {
      await consume({ ...base, type: "session_start" })
      await consume({
        ...base,
        type: "content_block_start",
        role: "user",
        messageId: "extension-user",
        block: { type: "text", text: "background request" },
      })
      await consume({
        ...base,
        type: "message_delta",
        delta: { type: "text", text: "delayed answer" },
      })
      await consume({
        ...base,
        delivery: undefined,
        type: "message_delta",
        delta: { type: "text", text: "duplicate" },
      })
      await consume({
        ...base,
        type: "permission_request",
        request: {
          id: "idle-approve",
          toolInfo: {
            id: "bash",
            name: "bash",
            description: "Run shell",
            parameters: { type: "object" },
          },
        },
      })
      expect(
        useChatStore
          .getState()
          .sessions["idle-chat"].pendingApprovals.some(
            (approval) =>
              approval.sessionId === "idle-chat" && approval.requestId.includes("idle-approve")
          )
      ).toBe(true)
      await consume({ ...base, type: "done", success: true })
      expect(persist).toHaveBeenCalledWith(
        "idle-chat",
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            parts: [expect.objectContaining({ type: "text", text: "background request" })],
          }),
          expect.objectContaining({
            role: "assistant",
            parts: [expect.objectContaining({ type: "text", text: "delayed answer" })],
          }),
        ])
      )
      expect(useChatStore.getState().sessions["idle-chat"].status).toBe("idle")
      const count = persist.mock.calls.length
      useAgentRuntimeStore
        .getState()
        .setSessionExternalLink("idle-chat", { agentId: "pi", sessionId: "forked" })
      await consume({ ...base, type: "session_start" })
      await consume({
        ...base,
        type: "message_delta",
        delta: { type: "text", text: "old process" },
      })
      await consume({ ...base, type: "done", success: true })
      expect(persist).toHaveBeenCalledTimes(count)
    } finally {
      persist.mockClear()
      persistStreaming.mockClear()
      registry.release("idle-chat")
    }
  })
  it("flushes a detached autonomous reply and refuses late events", async () => {
    const { useChatStore } = await import("@/stores/chat/chat-store")
    const { SessionCoalescingRegistry } = await import("./stream-coalescing")
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "pi" },
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
    })
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("detach-chat", { agentId: "pi", sessionId: "detached-native" })
    useChatStore.getState().replaceSessionMessages("detach-chat", [])
    const persist = jest.fn()
    const registry = new SessionCoalescingRegistry({
      onCommit: (id, messages) => useChatStore.getState().replaceSessionMessages(id, messages),
      onPersist: persist,
      persistDelayMs: 10000,
    })
    const consume = createExternalIdleEventConsumer(
      "detach-chat",
      "pi",
      "detached-native",
      registry
    )
    const base = {
      delivery: "out_of_band" as const,
      sessionId: "detached-native",
      timestamp: new Date(),
    }
    await consume({ ...base, type: "session_start" })
    await consume({
      ...base,
      type: "message_delta",
      delta: { type: "text", text: "retained partial" },
    })
    expect(persist).not.toHaveBeenCalled()
    await consume.dispose()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions["detach-chat"].messages[0].parts).toEqual([
      expect.objectContaining({ type: "text", text: "retained partial" }),
    ])
    await consume({ ...base, type: "message_delta", delta: { type: "text", text: "discard late" } })
    expect(persist).toHaveBeenCalledTimes(1)
  })
})
