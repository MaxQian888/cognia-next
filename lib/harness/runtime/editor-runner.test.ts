import type {
  AppSettings,
  ChatSession,
  PermissionRequestEvent,
  SendOptions,
} from "@cognia/agent-config-types"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { RunAndCaptureOptions } from "@/lib/claude/run-and-capture"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { buildContextTree } from "../context-tree"
import { makeComponents, makeRun, makeRunConfig, makeTask } from "../test-fixtures"
import {
  STRUCTURED_CONTEXT_MAX_CHARS,
  chooseEditorChannel,
  decideEditorToolCall,
  runEditorSession,
  type EditorRunnerDeps,
  type EditorSessionInput,
} from "./editor-runner"

const current = makeComponents()
const context = buildContextTree({
  task: makeTask(),
  current,
  editable: ["memory", "guardrails"],
  rollouts: [],
})

function modelDeps(answers: string[], prompts: string[] = []): EditorRunnerDeps["model"] {
  const client: LlmClient = {
    reportsCallUsage: true,
    complete: async (prompt, options) => {
      prompts.push(prompt)
      options?.onUsage?.({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
      return answers.shift() ?? "nonsense"
    },
  }
  return {
    getSettings: async () => ({}) as AppSettings,
    buildClient: () => client,
    bookUsage: async () => ({ costUsd: 0.01, costKnown: true }),
  }
}

interface FsState {
  files: Map<string, string>
  removed: string[]
}

function fsDeps(state: FsState): EditorRunnerDeps["fs"] {
  const strip = (root: string, rel: string) => `${root.replace("/app/", "")}/${rel}`
  return {
    writeAppDataFile: async (rel, bytes) => {
      state.files.set(rel, new TextDecoder().decode(bytes))
      return `/app/${rel}`
    },
    appDataPath: async (rel) => `/app/${rel}`,
    removeAppDataDirectory: async (rel) => {
      state.removed.push(rel)
    },
    walk: async (root) => {
      const prefix = `${root.replace("/app/", "")}/`
      return {
        files: [...state.files.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ relPath: k.slice(prefix.length), size: 1 })),
        truncated: false,
      }
    },
    readText: async (root, rel) => {
      const content = state.files.get(strip(root, rel))
      if (content === undefined) throw new Error("missing")
      return { content, sha256: "h", size: content.length }
    },
  }
}

function agenticDeps(
  state: FsState,
  onTurn: (cap: RunAndCaptureOptions, root: string) => Promise<void>,
  adapter: "claude-agent-sdk" | "ai-sdk" = "ai-sdk"
) {
  const contexts: BuildOptionsContext[] = []
  const deleted: string[] = []
  const deps: EditorRunnerDeps["agentic"] = {
    createSession: async (partial) =>
      ({ id: "ed1", createdAt: 1, updatedAt: 1, ...partial }) as ChatSession,
    deleteSession: async (id) => {
      deleted.push(id)
    },
    getSettings: async () => null,
    resolveSendOptions: async (ctx) => {
      contexts.push(ctx)
      return {
        turnId: ctx.turnId,
        execution: { runtimeAdapter: adapter },
        pluginTools: [{ name: "artifact_create" }],
      } as unknown as SendOptions
    },
    runTurn: async (_sid, _prompt, _opts, cap) => {
      await onTurn(cap, (contexts[0].session?.workingDir as string) ?? "")
      return {
        text: "done",
        messageId: "m",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
        usage: { inputTokens: 1000, outputTokens: 200 },
        resultSubtype: "success",
      }
    },
    claimTurnUsage: () => {},
    bookUsage: async () => ({ costUsd: 0.2, costKnown: true }),
    surfaceUsageFromUsageInfo: (u) => ({
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
    }),
    now: () => 1,
    newId: () => "turn-ed",
  }
  return { deps, contexts, deleted }
}

function input(over: Partial<EditorSessionInput> = {}): EditorSessionInput {
  return {
    run: makeRun({ config: makeRunConfig({ editorChannel: "structured" }) }),
    label: "dom1",
    attempt: 1,
    role: "DOM",
    context,
    current,
    policy: { editable: ["memory", "guardrails"] },
    agent: { providerId: "anthropic", model: "sonnet" },
    signal: new AbortController().signal,
    ...over,
  }
}

describe("chooseEditorChannel", () => {
  it("inlines when the evidence fits and goes agentic otherwise", () => {
    expect(chooseEditorChannel("auto", context).channel).toBe("structured")
    const huge = { ...context, "rollouts/base1.md": "x".repeat(STRUCTURED_CONTEXT_MAX_CHARS + 10) }
    expect(chooseEditorChannel("auto", huge).channel).toBe("agentic")
    expect(chooseEditorChannel("structured", huge).channel).toBe("structured")
    expect(chooseEditorChannel("agentic", context).channel).toBe("agentic")
  })
})

describe("runEditorSession (structured)", () => {
  const state = (): FsState => ({ files: new Map(), removed: [] })

  it("returns a valid proposal on the first answer", async () => {
    const answer = JSON.stringify({
      decision: "edit",
      notes: "- memory.md: base1 missed the separator",
      files: { "memory.md": "Reports go in report.md.\nCSV files use ; separators." },
    })
    const out = await runEditorSession(input(), {
      model: modelDeps([answer]),
      agentic: agenticDeps(state(), async () => {}).deps,
      fs: fsDeps(state()),
    })
    expect(out).toMatchObject({
      outcome: "changed",
      channel: "structured",
      attempts: 1,
      modelCalls: 1,
    })
    expect(out.components.memory).toContain("separators")
    expect(out.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      costUnknown: false,
    })
  })

  it("retries once with the validator errors and the previous answer, then falls back", async () => {
    const prompts: string[] = []
    const bad = JSON.stringify({ decision: "edit", notes: "", files: { "skills/x/SKILL.md": "x" } })
    const out = await runEditorSession(input(), {
      model: modelDeps([bad, "not json"], prompts),
      agentic: agenticDeps(state(), async () => {}).deps,
      fs: fsDeps(state()),
    })
    expect(out.outcome).toBe("fell-back")
    expect(out.components).toBe(current)
    expect(out.modelCalls).toBe(2)
    expect(prompts[1]).toContain("rejected by the harness validator")
    expect(prompts[1]).toContain(`Your previous answer was:\n${bad}`)
    expect(out.usage.inputTokens).toBe(200)
  })

  it("uses the composer model for compositions", async () => {
    const built: unknown[] = []
    const deps = modelDeps([JSON.stringify({ decision: "keep_base", notes: "none", files: {} })])
    const buildClient = deps.buildClient
    deps.buildClient = (args) => {
      built.push(args)
      return buildClient(args)
    }
    const out = await runEditorSession(
      input({
        role: "COMPOSE",
        run: makeRun({
          config: makeRunConfig({
            editorChannel: "structured",
            models: { composer: { model: "big" } },
          }),
        }),
      }),
      { model: deps, agentic: agenticDeps(state(), async () => {}).deps, fs: fsDeps(state()) }
    )
    expect(out.outcome).toBe("kept")
    expect(built[0]).toMatchObject({ modelOverride: "big" })
  })
})

describe("runEditorSession (agentic)", () => {
  it("lets the editor edit its scratch copy and reads the proposal back", async () => {
    const state: FsState = { files: new Map(), removed: [] }
    const fs = fsDeps(state)
    const decisions: string[] = []
    const { deps, contexts, deleted } = agenticDeps(state, async (cap, root) => {
      for (const [toolName, toolInput] of [
        ["Write", { file_path: `${root}/harness/memory.md` }],
        ["Write", { file_path: `${root}/NOTES.md` }],
        ["Write", { file_path: `${root}/rollouts/base1.md` }],
        ["Bash", { command: "ls" }],
      ] as const) {
        const d = await cap.onPermissionRequest!({
          toolName,
          input: toolInput,
        } as unknown as PermissionRequestEvent)
        decisions.push(`${toolName}:${d.decision}`)
      }
      const dir = root.replace("/app/", "")
      state.files.set(`${dir}/harness/memory.md`, "Reports go in report.md.\nUse ; separators.")
      state.files.set(`${dir}/NOTES.md`, "CHANGED\n- memory.md: separator")
    })
    const out = await runEditorSession(
      input({ run: makeRun({ config: makeRunConfig({ editorChannel: "agentic" }) }) }),
      { model: modelDeps([]), agentic: deps, fs }
    )
    expect(decisions).toEqual(["Write:allow", "Write:allow", "Write:deny", "Bash:deny"])
    expect(out).toMatchObject({ outcome: "changed", channel: "agentic", modelCalls: 1 })
    expect(out.components.memory).toContain("separators")
    expect(out.notes).toContain("CHANGED")
    expect(out.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, costUsd: 0.2 })

    // Two resolutions: the second denies every plugin tool and, on the AI-SDK
    // lane, lists the writers so they are visible (they still ask).
    expect(contexts).toHaveLength(2)
    const grant = contexts[1].capabilityGrants![0]
    expect(grant.tools?.deny).toEqual(
      expect.arrayContaining([
        "artifact_create",
        "mcp__cognia-plugin-tools__artifact_create",
        "Bash",
      ])
    )
    expect(grant.tools?.restrictTo).toContain("Write")
    expect(grant.mcpServers).toEqual({ only: [] })
    expect(grant.subagents).toEqual({ only: [] })
    expect(contexts[1].character?.systemPrompt).toMatch(/NOTES\.md/)
    expect(contexts[1].session?.visibility).toBe("embedded")
    expect(deleted).toEqual(["ed1"])
    expect(state.removed).toEqual(["harness-evolution/run-1/dom1/editor-1"])
  })

  it("keeps writers out of the auto-approved list on the Claude Agent SDK lane", async () => {
    const state: FsState = { files: new Map(), removed: [] }
    const { deps, contexts } = agenticDeps(state, async () => {}, "claude-agent-sdk")
    const out = await runEditorSession(
      input({ run: makeRun({ config: makeRunConfig({ editorChannel: "agentic" }) }) }),
      { model: modelDeps([]), agentic: deps, fs: fsDeps(state) }
    )
    expect(contexts[1].capabilityGrants![0].tools?.restrictTo).not.toContain("Write")
    // No notes and no edits: the editor kept the base.
    expect(out.outcome).toBe("kept")
  })

  it("propagates a failed session and still cleans up", async () => {
    const state: FsState = { files: new Map(), removed: [] }
    const { deps, deleted } = agenticDeps(state, async () => {
      throw new Error("provider down")
    })
    await expect(
      runEditorSession(
        input({ run: makeRun({ config: makeRunConfig({ editorChannel: "agentic" }) }) }),
        {
          model: modelDeps([]),
          agentic: deps,
          fs: fsDeps(state),
        }
      )
    ).rejects.toThrow("provider down")
    expect(deleted).toEqual(["ed1"])
    expect(state.removed).toHaveLength(1)
  })

  it("treats an error result as a failed session", async () => {
    const state: FsState = { files: new Map(), removed: [] }
    const { deps } = agenticDeps(state, async () => {})
    deps.runTurn = async () => ({
      text: "",
      messageId: "m",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      resultSubtype: "error_max_turns",
    })
    await expect(
      runEditorSession(
        input({ run: makeRun({ config: makeRunConfig({ editorChannel: "agentic" }) }) }),
        {
          model: modelDeps([]),
          agentic: deps,
          fs: fsDeps(state),
        }
      )
    ).rejects.toThrow("error_max_turns")
  })
})

describe("decideEditorToolCall", () => {
  const root = "/app/scratch"
  it("reads anywhere inside, writes only the harness and notes", () => {
    expect(decideEditorToolCall("Read", { file_path: "rollouts/base1.md" }, root).allow).toBe(true)
    expect(decideEditorToolCall("Read", { file_path: "/etc/hosts" }, root).allow).toBe(false)
    expect(
      decideEditorToolCall("Edit", { file_path: "harness/skills/a/SKILL.md" }, root).allow
    ).toBe(true)
    expect(decideEditorToolCall("mcp__cognia-tools__write", { path: "NOTES.md" }, root).allow).toBe(
      true
    )
    expect(decideEditorToolCall("Write", { file_path: "context/task.md" }, root).allow).toBe(false)
    expect(
      decideEditorToolCall(
        "mcp__cognia-tools__apply_patch",
        { patch: "*** Add File: harness/x" },
        root
      )
    ).toMatchObject({ allow: false })
    expect(decideEditorToolCall("WebFetch", {}, root).allow).toBe(false)
  })
})
