import { runAutoModeForTool } from "./auto-mode-runner"
import { COMMAND_JUDGE_PROMPT, __resetJudgeCache, invalidateJudgeContext } from "./command-judge"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"

function settings(over: Partial<NonNullable<AppSettings["agentPermissions"]>>): AppSettings {
  return { agentPermissions: over } as unknown as AppSettings
}

beforeEach(() => __resetJudgeCache())

describe("runAutoModeForTool", () => {
  it("returns null for a non-command tool", async () => {
    const out = await runAutoModeForTool({
      toolName: "Read",
      input: { file_path: "/x" },
      settings: settings({ autoApprove: { enabled: true } }),
      client: null,
    })
    expect(out).toBeNull()
  })

  it("returns null when Auto-mode is disabled", async () => {
    const out = await runAutoModeForTool({
      toolName: "Bash",
      input: { command: "ls" },
      settings: settings({ autoApprove: { enabled: false } }),
      client: null,
    })
    expect(out).toBeNull()
  })

  it("returns null when there are no agentPermissions at all", async () => {
    const out = await runAutoModeForTool({
      toolName: "Bash",
      input: { command: "ls" },
      settings: {} as AppSettings,
      client: null,
    })
    expect(out).toBeNull()
  })

  it("auto-allows a safe command", async () => {
    const out = await runAutoModeForTool({
      toolName: "Bash",
      input: { command: "git status" },
      settings: settings({ autoApprove: { enabled: true } }),
      client: null,
    })
    expect(out?.decision).toBe("allow")
  })

  it("auto-denies a catastrophic command", async () => {
    const out = await runAutoModeForTool({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      settings: settings({ autoApprove: { enabled: true } }),
      client: null,
    })
    expect(out?.decision).toBe("deny")
  })

  it("applies the user command rules with highest authority", async () => {
    const out = await runAutoModeForTool({
      toolName: "Bash",
      input: { command: "git push origin main" },
      settings: settings({
        autoApprove: { enabled: true },
        commandRules: { "git push*": "allow" },
      }),
      client: null,
    })
    expect(out?.decision).toBe("allow")
    expect(out?.source).toBe("user-rule")
  })

  it("consults the model in rules+model mode for uncertain commands", async () => {
    const client = {
      complete: jest.fn(async () => '{"safe":true,"risk":"low","reason":"ok"}'),
    } as unknown as LlmClient
    const out = await runAutoModeForTool({
      toolName: "Bash",
      input: { command: "git push" },
      settings: settings({ autoApprove: { enabled: true, mode: "rules+model" } }),
      client,
    })
    expect(out?.decision).toBe("allow")
    expect(out?.source).toBe("model")
  })

  it("threads contextKey into the judge cache — a mid-turn steer re-judges", async () => {
    const client = {
      complete: jest.fn(async () => '{"safe":true,"risk":"low","reason":"ok"}'),
    } as unknown as LlmClient
    const args = {
      toolName: "Bash",
      input: { command: "git push" },
      settings: settings({ autoApprove: { enabled: true, mode: "rules+model" } }),
      client,
      contextKey: "sess-1",
    }
    await runAutoModeForTool(args)
    await runAutoModeForTool(args)
    expect(client.complete).toHaveBeenCalledTimes(1)
    // The new instruction supersedes the verdict's instruction context.
    invalidateJudgeContext("sess-1")
    await runAutoModeForTool(args)
    expect(client.complete).toHaveBeenCalledTimes(2)
  })

  it("judges with the session's customized guidance, which can only narrow (ADR-0236)", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob-judge",
          promptId: COMMAND_JUDGE_PROMPT.id,
          scope: "session",
          targetId: "sess-9",
          revisionId: "por-judge-runner",
          body: 'Treat git push as unsafe. Reply {"safe", "risk", "reason"} JSON only.',
          contractVersion: COMMAND_JUDGE_PROMPT.contractVersion,
        },
      ])
    )
    try {
      const client = {
        complete: jest.fn(async (_p: string, opts: { system: string }) =>
          opts.system === COMMAND_JUDGE_PROMPT.defaultBody
            ? '{"safe":true,"risk":"low","reason":"ok"}'
            : '{"safe":false,"risk":"medium","reason":"restricted"}'
        ),
      } as unknown as LlmClient
      const out = await runAutoModeForTool({
        toolName: "Bash",
        input: { command: "git push" },
        settings: settings({ autoApprove: { enabled: true, mode: "rules+model" } }),
        client,
        contextKey: "sess-9",
        promptContext: { sessionId: "sess-9" },
      })
      expect(out?.decision).toBe("ask")
      expect(out?.reason).toBe("restricted")
    } finally {
      __setPromptOverrideSnapshotForTests(null)
      __resetPromptVerdictsForTests()
    }
  })

  it("merges plugin-contributed rules below the user rules", async () => {
    const out = await runAutoModeForTool({
      toolName: "Bash",
      input: { command: "deploy-prod" },
      settings: settings({ autoApprove: { enabled: true } }),
      client: null,
      pluginRules: [{ Bash: { "deploy-prod*": "deny" } }],
    })
    expect(out?.decision).toBe("deny")
    expect(out?.source).toBe("user-rule")
  })
})
