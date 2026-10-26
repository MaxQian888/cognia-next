import type {
  Character,
  ChatSession,
  PermissionRequestEvent,
  SendOptions,
} from "@cognia/agent-config-types"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { RunAndCaptureOptions, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { createToolRuleState } from "../tool-rules"
import { makeComponents, makeRun, makeTask } from "../test-fixtures"
import type { IsolationDeps } from "./isolation"
import { isSessionExcludedFromLiveToolRules } from "./live-rules"
import {
  createProbePermissionResponder,
  discoverProbeToolSurface,
  runProbe,
  type ProbeInput,
  type ProbeRunnerDeps,
} from "./probe-runner"

const character: Character = {
  id: "agent-1",
  name: "Analyst",
  avatarColor: "oklch(0.6 0 0)",
  systemPrompt: "old",
  skillIds: ["lib-skill"],
  createdAt: 1,
  updatedAt: 1,
}

function isolationDeps(files: Record<string, string> = {}): IsolationDeps & {
  removed: string[]
} {
  const removed: string[] = []
  return {
    removed,
    fs: {
      readHostFileBase64: async () => btoa("a,b\n1,2\n"),
      writeAppDataFile: async (rel) => `/app/${rel}`,
      appDataPath: async (rel) => `/app/${rel}`,
      removeAppDataDirectory: async (rel) => {
        removed.push(rel)
      },
      walk: async () => ({
        files: Object.entries(files).map(([relPath, text]) => ({ relPath, size: text.length })),
        truncated: false,
      }),
      readText: async (_root, relPath) => ({
        content: files[relPath] ?? "",
        sha256: `sha-${relPath}`,
        size: (files[relPath] ?? "").length,
      }),
    },
    git: {
      acquire: async () => {
        throw new Error("no git here")
      },
    },
    now: () => 100,
  }
}

interface Harness {
  deps: ProbeRunnerDeps
  contexts: BuildOptionsContext[]
  sent: { options: SendOptions; cap: RunAndCaptureOptions }[]
  deleted: string[]
  booked: { operationId: string; sessionId: string; usage: Record<string, unknown> }[]
  claimed: string[]
  isolation: ReturnType<typeof isolationDeps>
}

function harness(
  turn: (cap: RunAndCaptureOptions) => Promise<RunAndCaptureResult>,
  options: {
    files?: Record<string, string>
    resolved?: Partial<SendOptions>
    costKnown?: boolean
  } = {}
): Harness {
  const contexts: BuildOptionsContext[] = []
  const sent: Harness["sent"] = []
  const deleted: string[] = []
  const booked: Harness["booked"] = []
  const claimed: string[] = []
  const isolation = isolationDeps(options.files)
  let id = 0
  const deps: ProbeRunnerDeps = {
    isolation,
    createSession: async (partial) =>
      ({ id: `s${++id}`, createdAt: 1, updatedAt: 1, ...partial }) as ChatSession,
    deleteSession: async (sid) => {
      deleted.push(sid)
    },
    getSettings: async () => null,
    resolveSendOptions: async (ctx) => {
      contexts.push(ctx)
      return {
        model: "m",
        provider: "p",
        turnId: ctx.turnId,
        execution: { runtimeAdapter: "ai-sdk" },
        pluginTools: [{ name: "load_skill" }, { name: "pet_say" }],
        mcpServers: { docs: {}, "cognia-tools": {} },
        ...options.resolved,
      } as unknown as SendOptions
    },
    runTurn: async (_sid, _prompt, opts, cap) => {
      sent.push({ options: opts, cap })
      return turn(cap)
    },
    claimTurnUsage: (sid, turnId) => {
      claimed.push(`${sid}:${turnId}`)
    },
    bookUsage: async (input) => {
      booked.push(input as Harness["booked"][number])
      return { costUsd: 0.02, costKnown: options.costKnown ?? true }
    },
    surfaceUsageFromUsageInfo: (usage) => ({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.totalCostUsd,
    }),
    homeDir: async () => "/Users/me",
    fetchTraceId: async () => "trace-1",
    now: (() => {
      let t = 1000
      return () => (t += 10)
    })(),
    newId: () => "turn-1",
  }
  return { deps, contexts, sent, deleted, booked, claimed, isolation }
}

function input(over: Partial<ProbeInput> = {}): ProbeInput {
  return {
    run: makeRun({
      task: makeTask({
        inputFiles: [{ sourcePath: "/host/data.csv", relativePath: "data.csv" }],
      }),
    }),
    label: "base1",
    attempt: 1,
    snapshot: { id: "snap-1", components: makeComponents() },
    baseCharacter: character,
    carriedSkillIds: ["builtin-x"],
    environmentFingerprint: "hef1-x",
    surface: {
      pluginToolDenials: ["mcp__cognia-plugin-tools__pet_say"],
      allowedMcpServerNames: [],
    },
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...over,
  }
}

const reply = (over: Partial<RunAndCaptureResult> = {}): RunAndCaptureResult => ({
  text: "Wrote report.md",
  messageId: "m1",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
  usage: { inputTokens: 100, outputTokens: 20, totalCostUsd: 0 },
  resultSubtype: "success",
  ...over,
})

describe("runProbe", () => {
  it("runs the snapshot isolated, records evidence and cleans up", async () => {
    let excludedDuringTurn = false
    const h = harness(
      async (cap) => {
        excludedDuringTurn = isSessionExcludedFromLiveToolRules("s1")
        cap.onEvent?.({ type: "text-delta", delta: "Working" })
        cap.onEvent?.({
          type: "tool-call",
          toolName: "Write",
          input: { file_path: "report.md" },
          id: "t1",
        })
        cap.onEvent?.({ type: "tool-result", toolName: "Write", result: "ok", id: "t1" })
        return reply()
      },
      { files: { "report.md": "# Report", "data.csv": "a,b\n1,2\n" } }
    )
    const outcome = await runProbe(input(), h.deps)
    // The stored agent's live tool rules stay off the probe while it runs.
    expect(excludedDuringTurn).toBe(true)
    expect(isSessionExcludedFromLiveToolRules("s1")).toBe(false)

    const ctx = h.contexts[0]
    expect(ctx.character?.systemPrompt).toBe(makeComponents().systemPrompt)
    expect(ctx.character?.skillIds).toEqual(["builtin-x"])
    expect(ctx.harnessOverlay?.snapshotId).toBe("snap-1")
    expect(ctx.session?.workingDir).toBe("/app/harness-evolution/run-1/base1/work")
    expect(ctx.session?.visibility).toBe("embedded")
    expect(ctx.session?.memoryLearn).toBe(false)
    expect(ctx.activeProject?.roots[0].path).toBe("/app/harness-evolution/run-1/base1/work")
    expect(ctx.capabilityGrants?.[0].tools?.deny).toContain("mcp__cognia-plugin-tools__pet_say")
    expect(ctx.capabilityGrants?.[0].permissionMode).toBe("default")
    expect(ctx.skillRenderMode).toBe("hybrid")

    expect(h.sent[0].options.toolResultReviewEnabled).toBe(true)
    expect(h.sent[0].cap.execution).toMatchObject({
      kind: "subagent",
      runId: "run-1",
      taskId: "run-1:base1",
    })
    expect(h.claimed).toEqual(["s1:turn-1"])
    expect(h.booked[0]).toMatchObject({
      operationId: "harness:run-1:base1:1",
      sessionId: "harness:run-1",
      usage: { model: "m", providerId: "p", runId: "run-1", turnId: "turn-1" },
    })

    expect(outcome.evidence.delivered).toBe(true)
    expect(outcome.evidence.deliverables.map((d) => d.path)).toEqual(["report.md", "data.csv"])
    expect(outcome.evidence.trajectory).toContain("[ACTION] Write")
    expect(outcome.evidence.traceId).toBe("trace-1")
    expect(outcome.evidence.caveats).toBeUndefined()
    // AI-SDK reported zero: the priced ledger row is the cost.
    expect(outcome.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.02,
      costUnknown: false,
    })
    expect(h.deleted).toEqual(["s1"])
    expect(h.isolation.removed).toEqual(["harness-evolution/run-1/base1"])
  })

  it("applies call caps and the probe policy to permission requests", async () => {
    const decisions: string[] = []
    const h = harness(async (cap) => {
      const ask = async (toolName: string, toolInput: Record<string, unknown>) => {
        const d = await cap.onPermissionRequest!({
          type: "permission_request",
          sessionId: "s1",
          requestId: toolName,
          toolUseID: toolName,
          toolName,
          input: toolInput,
        } as PermissionRequestEvent)
        decisions.push(`${toolName}:${d.decision}`)
      }
      await ask("Bash", { command: "pnpm test" })
      await ask("Bash", { command: "git push" })
      await ask("Write", { file_path: "/Users/me/x" })
      return reply({ usage: undefined })
    })
    const outcome = await runProbe(input(), h.deps)
    expect(decisions).toEqual(["Bash:allow", "Bash:deny", "Write:deny"])
    expect(outcome.evidence.blockedActions.map((b) => b.toolName)).toEqual(["Bash", "Write"])
    expect(outcome.evidence.trajectory).toContain("Blocked by the probe policy")
    expect(outcome.evidence.caveats).toEqual([
      expect.stringMatching(/Shell commands ran on this machine/),
    ])
    expect(outcome.usage.costUnknown).toBe(true)
    expect(h.booked).toEqual([])
  })

  it("rewrites tool results through the harness rules", async () => {
    let rewritten: unknown
    const h = harness(async (cap) => {
      const decision = await cap.onToolResultReview!({
        toolName: "Bash",
        input: {},
        result: "boom: command not found",
        isError: true,
      })
      rewritten =
        decision && "updatedToolOutput" in decision ? decision.updatedToolOutput : undefined
      return reply()
    })
    await runProbe(
      input({
        snapshot: {
          id: "snap-2",
          components: makeComponents({
            toolRules: [
              {
                id: "hint",
                kind: "error-hint",
                tool: "Bash",
                patterns: ["not found"],
                hint: "Install it first.",
              },
            ],
          }),
        },
      }),
      h.deps
    )
    expect(rewritten).toContain("[harness hint hint] Install it first.")
  })

  it("notes rules and budgets a Claude Agent SDK or AI-SDK turn cannot enforce", async () => {
    const sdk = harness(
      async () => reply({ usage: { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.5 } }),
      {
        resolved: { execution: { runtimeAdapter: "claude-agent-sdk" } } as Partial<SendOptions>,
      }
    )
    const out = await runProbe(input({ maxBudgetUsd: 1 }), sdk.deps)
    expect(out.evidence.caveats).toEqual([expect.stringMatching(/result rules/)])
    expect(out.usage.costUsd).toBe(0.5)
    expect(sdk.contexts[0].capabilityGrants?.[0].maxBudgetUsd).toBe(1)

    const aiSdk = harness(async () => reply())
    const out2 = await runProbe(input({ maxBudgetUsd: 1 }), aiSdk.deps)
    expect(out2.evidence.caveats).toEqual([
      expect.stringMatching(/cannot stop a turn at a dollar ceiling/),
    ])
  })

  it("records a failed turn as evidence and books the streamed usage", async () => {
    const h = harness(async (cap) => {
      cap.onEvent?.({ type: "usage", usage: { inputTokens: 7, outputTokens: 3 } } as never)
      throw new Error("provider exploded")
    })
    const out = await runProbe(input(), h.deps)
    expect(out.evidence.error).toBe("provider exploded")
    expect(out.evidence.delivered).toBe(false)
    expect(h.booked[0].usage).toMatchObject({ inputTokens: 7, outputTokens: 3 })
    expect(out.usage.costUsd).toBe(0.02)
  })

  it("marks error result subtypes as failures", async () => {
    const h = harness(async () => reply({ resultSubtype: "error_max_turns" }))
    const out = await runProbe(input(), h.deps)
    expect(out.evidence.error).toBe("The turn ended with error_max_turns")
  })

  it("propagates cancellation after cleaning up", async () => {
    const controller = new AbortController()
    const h = harness(async () => {
      controller.abort()
      throw new Error("aborted")
    })
    await expect(runProbe(input({ signal: controller.signal }), h.deps)).rejects.toThrow("aborted")
    expect(h.deleted).toEqual(["s1"])
    expect(h.isolation.removed).toEqual(["harness-evolution/run-1/base1"])
  })

  it("runs text-only without a working directory", async () => {
    const h = harness(async () => reply())
    const out = await runProbe(
      input({
        run: makeRun({
          task: makeTask({ isolation: "none", checks: [], expectedDeliverables: [] }),
        }),
      }),
      h.deps
    )
    expect(h.contexts[0].session?.workingDir).toBeUndefined()
    expect(h.contexts[0].activeProject).toBeNull()
    expect(h.contexts[0].capabilityGrants?.[0].tools?.deny).toContain("Bash")
    expect(out.evidence.delivered).toBe(true)
  })

  it("cleans up when the workspace cannot be prepared", async () => {
    const h = harness(async () => reply())
    h.deps.isolation.fs.readHostFileBase64 = async () => {
      throw new Error("unreadable")
    }
    await expect(runProbe(input(), h.deps)).rejects.toThrow("unreadable")
    expect(h.deleted).toEqual(["s1"])
  })
})

describe("createProbePermissionResponder", () => {
  it("denies a capped tool before the probe policy", () => {
    const state = createToolRuleState()
    state.calls.set("cap:Bash", 1)
    const blocked: string[] = []
    const respond = createProbePermissionResponder({
      rules: [{ id: "cap", kind: "call-cap", tool: "Bash", maxCalls: 1, reason: "Enough." }],
      state,
      policy: {
        isolation: "files",
        root: "/r",
        networkOff: false,
        allowedMcpServerNames: new Set(),
      },
      onBlocked: (a) => blocked.push(a.reason),
    })
    const decision = respond({
      toolName: "Bash",
      input: { command: "ls" },
    } as unknown as PermissionRequestEvent)
    expect(decision.decision).toBe("deny")
    expect(blocked[0]).toMatch(/harness rule cap/)
  })
})

describe("discoverProbeToolSurface", () => {
  it("lists denied plugin tools and declared MCP server names", async () => {
    const h = harness(async () => reply())
    const surface = await discoverProbeToolSurface(
      {
        run: makeRun(),
        snapshot: { id: "s", components: makeComponents() },
        baseCharacter: character,
        carriedSkillIds: [],
      },
      h.deps
    )
    expect(surface).toEqual({
      pluginToolDenials: ["pet_say", "mcp__cognia-plugin-tools__pet_say"],
      allowedMcpServerNames: ["docs"],
    })
    expect(h.deleted).toEqual(["s1"])
  })
})
