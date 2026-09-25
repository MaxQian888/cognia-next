import { parseCogniaDeeplink } from "./cognia-deeplink"

describe("parseCogniaDeeplink", () => {
  it("parses routes shared by the desktop and mobile shells", () => {
    expect(parseCogniaDeeplink("cognia://session/s-1")).toMatchObject({
      kind: "open_session",
      sessionId: "s-1",
    })
    expect(parseCogniaDeeplink("cognia://workflow-run/wf-1/run-1")).toMatchObject({
      kind: "open_workflow_run",
      workflowId: "wf-1",
      runId: "run-1",
    })
    expect(parseCogniaDeeplink("cognia://scheduler/task/task-1")).toMatchObject({
      kind: "open_scheduler_task",
      taskId: "task-1",
      runToken: undefined,
    })
  })

  it("parses the Browser Companion's issue and agent-task links", () => {
    // `lib/browser-companion/service.ts:workDeepLink` mints both, and until
    // they were parsed here every "Open in Cognia" on a filed issue or an agent
    // task landed on the unknown-link toast.
    expect(parseCogniaDeeplink("cognia://issues/issue-1")).toMatchObject({
      kind: "open_issue",
      issueId: "issue-1",
    })
    expect(parseCogniaDeeplink("cognia://agent-tasks/task-1")).toMatchObject({
      kind: "open_agent_task",
      taskId: "task-1",
    })
    // Built with `encodeURIComponent`, so decoded here.
    expect(parseCogniaDeeplink("cognia://issues/a%2Fb%20c")).toMatchObject({
      kind: "open_issue",
      issueId: "a/b c",
    })
    // Singular hosts and the `?id=` fallback, like every other route here.
    expect(parseCogniaDeeplink("cognia://issue?id=issue-2")).toMatchObject({
      kind: "open_issue",
      issueId: "issue-2",
    })
    expect(parseCogniaDeeplink("cognia://agent-task?id=task-2")).toMatchObject({
      kind: "open_agent_task",
      taskId: "task-2",
    })
  })

  it("keeps a malformed escape as written rather than throwing", () => {
    expect(parseCogniaDeeplink("cognia://issues/%E0%A4%A")).toMatchObject({
      kind: "open_issue",
      issueId: "%E0%A4%A",
    })
  })

  it("carries the OS-promotion wake token on scheduler task links", () => {
    expect(parseCogniaDeeplink("cognia://scheduler/task/task-1?run=abc_DEF-9")).toMatchObject({
      kind: "open_scheduler_task",
      taskId: "task-1",
      runToken: "abc_DEF-9",
    })
    // Empty token = no token.
    expect(parseCogniaDeeplink("cognia://scheduler/task/task-1?run=")).toMatchObject({
      kind: "open_scheduler_task",
      taskId: "task-1",
      runToken: undefined,
    })
  })

  it("preserves mobile, connector, settings, and workspace routes", () => {
    expect(parseCogniaDeeplink("cognia://oauth/claude?code=c&state=s")).toMatchObject({
      kind: "oauth_callback",
      provider: "claude",
      code: "c",
      state: "s",
    })
    expect(parseCogniaDeeplink("cognia://im?conversationKey=matrix%3Abot%3Aroom")).toMatchObject({
      kind: "open_im",
      conversationKey: "matrix:bot:room",
    })
    expect(parseCogniaDeeplink("cognia://settings?tab=advanced")).toMatchObject({
      kind: "open_settings",
      settingsTab: "advanced",
    })
    expect(parseCogniaDeeplink("cognia://workspace?path=%2Ftmp%2Fproject")).toMatchObject({
      kind: "open_workspace",
      workspacePath: "/tmp/project",
    })
  })

  it("parses the Logto authorization callback and keeps foreign logto paths unknown", () => {
    expect(parseCogniaDeeplink("cognia://logto/callback?code=abc&state=xyz&error=denied")).toEqual({
      kind: "logto_callback",
      code: "abc",
      state: "xyz",
      error: "denied",
      raw: "cognia://logto/callback?code=abc&state=xyz&error=denied",
    })
    expect(parseCogniaDeeplink("cognia://logto?code=abc&state=xyz")).toMatchObject({
      kind: "logto_callback",
      code: "abc",
      state: "xyz",
      error: null,
    })
    expect(parseCogniaDeeplink("cognia://logto/other")).toMatchObject({ kind: "unknown" })
  })

  it("supports query fallbacks used by older shell integrations", () => {
    expect(parseCogniaDeeplink("cognia://pair?payload=pair-token")).toMatchObject({
      kind: "pair_qr",
      payload: "pair-token",
    })
    expect(parseCogniaDeeplink("cognia://pair/path-token")).toMatchObject({
      kind: "pair_qr",
      payload: "path-token",
    })
    expect(parseCogniaDeeplink("cognia://chat?id=chat-1")).toMatchObject({
      kind: "open_session",
      sessionId: "chat-1",
    })
    expect(parseCogniaDeeplink("cognia://workflow-run?workflowId=wf-q&runId=run-q")).toMatchObject({
      kind: "open_workflow_run",
      workflowId: "wf-q",
      runId: "run-q",
    })
    expect(parseCogniaDeeplink("cognia://scheduler?taskId=task-q")).toMatchObject({
      kind: "open_scheduler_task",
      taskId: "task-q",
    })
    expect(parseCogniaDeeplink("cognia://oauth?provider=openai")).toMatchObject({
      kind: "oauth_callback",
      provider: "openai",
      code: null,
      state: null,
    })
    expect(parseCogniaDeeplink("cognia://oauth")).toMatchObject({
      kind: "oauth_callback",
      provider: "default",
    })
  })

  it("keeps optional share and shell route fields optional", () => {
    expect(
      parseCogniaDeeplink("cognia://share?text=hello&url=https%3A%2F%2Fcognia.app")
    ).toMatchObject({
      kind: "share_target",
      text: "hello",
      url: "https://cognia.app",
    })
    expect(parseCogniaDeeplink("cognia://share")).toMatchObject({
      kind: "share_target",
      text: undefined,
      url: undefined,
    })
    expect(parseCogniaDeeplink("cognia://im")).toMatchObject({
      kind: "open_im",
      conversationKey: undefined,
    })
    expect(parseCogniaDeeplink("cognia://settings")).toMatchObject({
      kind: "open_settings",
      settingsTab: undefined,
    })
    expect(parseCogniaDeeplink("cognia://workspace")).toMatchObject({
      kind: "open_workspace",
      workspacePath: undefined,
    })
    expect(parseCogniaDeeplink("cognia://workflow-run")).toMatchObject({
      kind: "open_workflow_run",
      workflowId: "",
      runId: "",
    })
    expect(parseCogniaDeeplink("cognia://scheduler/other")).toMatchObject({
      kind: "open_scheduler_task",
      taskId: undefined,
    })
  })

  it("returns unknown for malformed and foreign URLs", () => {
    expect(parseCogniaDeeplink("not a url").kind).toBe("unknown")
    expect(parseCogniaDeeplink("https://example.com").kind).toBe("unknown")
  })
})
