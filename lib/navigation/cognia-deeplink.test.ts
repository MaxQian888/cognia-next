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
