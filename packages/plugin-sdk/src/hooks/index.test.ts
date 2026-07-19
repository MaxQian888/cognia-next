import type {
  PluginHooks,
  PluginHooksAll,
  HookPriority,
  HookRegistrationOptions,
  BuildOptionsHookInput,
  BuildOptionsHookOutput,
  ConnectorHookDecision,
  ConnectorHookEvents,
  ConnectorInboundHookPayload,
  ConnectorOutboundHookPayload,
  GoalHookEvents,
  GoalHookPayload,
  PluginTerminalLifecycleEvent,
  PluginTerminalSpawnDecision,
  PluginTerminalSpawnRequest,
  ProjectHookEvents,
  PreToolUseResult,
  ShareHookEvents,
  ShareLinkHookPayload,
  TerminalHookEvents,
} from "./index"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Hooks subpath is type-only. We assert assignability against
 * representative shapes so the SDK contract trips when upstream renames a
 * hook event or changes the registration options shape.
 */
describe("plugin-sdk: hooks", () => {
  it("re-exports the manifest-side hooks interfaces", () => {
    const baseHooks: PluginHooks = {}
    const completeHooks: PluginHooksAll = {}
    expect(baseHooks).toEqual({})
    expect(completeHooks).toEqual({})
  })

  it("HookPriority is a string-literal union for manifest declarations", () => {
    const priority: HookPriority = "normal"
    const options: HookRegistrationOptions = { priority }
    expect(options.priority).toBe("normal")
  })

  it("re-exports domain-specific hook event shapes", () => {
    const project: ProjectHookEvents = {}
    const toolResult: PreToolUseResult = { action: "allow" }
    const goal: GoalHookPayload = {
      goalId: "goal-1",
      sessionId: "session-1",
      status: "active",
      safeObjective: "Summarize the project",
      turnsUsed: 1,
      tokensUsed: 200,
    }
    const goalHooks: GoalHookEvents = {}
    const share: ShareLinkHookPayload = {
      code: "abc123",
      kind: "chat",
      url: "https://share.example/view/abc123",
    }
    const shareHooks: ShareHookEvents = {}
    const buildInput: BuildOptionsHookInput = {
      sessionId: "session-1",
      model: "claude",
      allowedTools: ["search"],
    }
    const buildOutput: BuildOptionsHookOutput = { maxTokens: 1024 }
    const terminalRequest: PluginTerminalSpawnRequest = {
      shell: "pwsh",
      rows: 24,
      cols: 80,
    }
    const terminalDecision: PluginTerminalSpawnDecision = terminalRequest
    const terminalEvent: PluginTerminalLifecycleEvent = {
      kind: "spawned",
      sessionId: "term-1",
    }
    const terminalHooks: TerminalHookEvents = {}
    const inbound: ConnectorInboundHookPayload = {
      adapterId: "lark",
      conversationKey: "chat-1",
      platform: "lark",
      segments: [],
      plainText: "hello",
      messageId: "msg-1",
    }
    const outbound: ConnectorOutboundHookPayload = {
      adapterId: "lark",
      conversationKey: "chat-1",
      platform: "lark",
      segments: [],
      source: "manual",
      idempotencyKey: "send-1",
    }
    const connectorDecision: ConnectorHookDecision = { action: "allow" }
    const connectorHooks: ConnectorHookEvents = {}

    expect(project).toEqual({})
    expect(toolResult.action).toBe("allow")
    expect(goal.goalId).toBe("goal-1")
    expect(goalHooks).toEqual({})
    expect(share.code).toBe("abc123")
    expect(shareHooks).toEqual({})
    expect(buildInput.allowedTools).toEqual(["search"])
    expect(buildOutput?.maxTokens).toBe(1024)
    expect(terminalDecision).toBe(terminalRequest)
    expect(terminalEvent.kind).toBe("spawned")
    expect(terminalHooks).toEqual({})
    expect(inbound.messageId).toBe("msg-1")
    expect(outbound.idempotencyKey).toBe("send-1")
    expect(connectorDecision.action).toBe("allow")
    expect(connectorHooks).toEqual({})
  })

  it("declares every public event-hook shape in the hooks barrel", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/hooks/index.ts"),
      "utf8"
    )
    const eventHookTypes = [
      "ProjectHookEvents",
      "GoalHookPayload",
      "GoalHookEvents",
      "ShareLinkHookPayload",
      "ShareHookEvents",
      "CanvasHookEvents",
      "ArtifactHookEvents",
      "ExportHookEvents",
      "ThemeHookEvents",
      "BuildOptionsHookInput",
      "BuildOptionsHookOutput",
      "AIHookEvents",
      "VectorHookEvents",
      "WorkflowHookEvents",
      "PluginTerminalSpawnRequest",
      "PluginTerminalSpawnDecision",
      "PluginTerminalLifecycleEvent",
      "TerminalHookEvents",
      "ConnectorInboundHookPayload",
      "ConnectorOutboundHookPayload",
      "ConnectorHookDecision",
      "ConnectorHookEvents",
      "UIHookEvents",
    ]

    for (const eventHookType of eventHookTypes) {
      expect(barrelSource).toContain(eventHookType)
    }
  })
})
