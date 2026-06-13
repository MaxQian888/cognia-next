import path from "node:path"
import React from "react"
import { act, render, waitFor } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

// Stub the durable history store so submitting in these tests never touches the
// real `~/.cognia/history.json` (most cases render without an injected `home`).
jest.mock("../input/history-store", () => ({
  appendHistory: jest.fn(),
  loadHistory: jest.fn(() => []),
}))

// The default model-meta resolver reads the real models.dev catalog and would
// dispatch SET_MODEL_META on a microtask after render — firing an act() warning
// in the synchronous-render cases below. Stub it to a never-settling promise so
// the effect is inert unless a test injects its own `resolveMeta` prop.
jest.mock("../runtime/model-meta", () => ({
  resolveModelMeta: () => new Promise(() => {}),
}))

import { App } from "./App"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { CreateSession } from "../hooks/useAgentSession"
import type { TranscriptEntry, TranscriptFs } from "../../agent/transcript"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { UsageInfo } from "../state/types"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  // The active model is remembered under the active provider (per-provider
  // memory); `model` mirrors it for display. `resolveActiveModel` reads the
  // per-provider slot, so both agree.
  model: "claude-x",
  providers: { anthropic: { model: "claude-x" } },
  cwd: "/work",
}

const sessionData: Record<string, TranscriptEntry[]> = {
  ses1: [
    { ts: 1, role: "user", content: "resumed question" },
    { ts: 2, role: "assistant", content: "resumed answer" },
  ],
}
const transcriptFs: TranscriptFs = {
  append: () => {},
  mkdirp: () => {},
  read: (p) => {
    const id = p.replace(/.*[\\/]/, "").replace(/\.jsonl$/, "")
    const entries = sessionData[id]
    return entries ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : null
  },
}

const result = (text: string): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
})

/** A fake session whose send streams a scripted answer. */
function fakeSession(answer = "the answer", usage?: UsageInfo) {
  const closed = jest.fn()
  const prompts: string[] = []
  const create: CreateSession = () => ({
    sessionId: "ses-fake",
    async send(prompt, opts) {
      prompts.push(prompt)
      opts.onEvent?.({ type: "text-delta", delta: answer })
      if (usage) opts.onEvent?.({ type: "usage", usage })
      return result(answer)
    },
    close: closed,
  })
  return { create, closed, prompts }
}

function type(text: string) {
  for (const ch of text) act(() => __fireInput(ch))
}

function submit() {
  act(() => __fireInput("", { return: true }))
}

describe("App", () => {
  beforeEach(() => __resetInk())

  it("persists a submitted line to the durable history store", async () => {
    const { appendHistory } = jest.requireMock("../input/history-store") as {
      appendHistory: jest.Mock
    }
    appendHistory.mockClear()
    const { create } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} home="/home/u/.cognia" />)
    type("remember me")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(appendHistory).toHaveBeenCalledWith("/home/u/.cognia", "remember me")
  })

  it("submits a prompt and renders the streamed answer", async () => {
    const { create } = fakeSession("hello there")
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("hello there"))
    expect(container.textContent).toContain("hi")
  })

  it("resolves a @skill mention: enables it and strips the token from the prompt", async () => {
    const { create, prompts } = fakeSession("done")
    const enabled: string[] = []
    const mentionProviders = {
      files: () => [],
      skills: async () => [
        { kind: "skill" as const, id: "skill_cite", label: "Cite", insert: "@skill:skill_cite" },
      ],
      agents: async () => [],
    }
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        mentionProviders={mentionProviders}
        persistSkillEnabled={(id) => enabled.push(id)}
      />
    )
    type("@skill:skill_cite explain")
    await act(async () => {
      submit()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(prompts.length).toBe(1))
    // The skill was enabled and its token stripped from what reaches the model.
    expect(enabled).toEqual(["skill_cite"])
    expect(prompts[0]).toBe("explain")
  })

  it("resolves a @agent mention: dispatches it and folds the result into the prompt", async () => {
    const { create, prompts } = fakeSession("done")
    const mentionProviders = {
      files: () => [],
      skills: async () => [],
      agents: async () => [
        {
          kind: "agent" as const,
          id: "code-reviewer",
          label: "code-reviewer",
          insert: "@agent:code-reviewer",
        },
      ],
    }
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        mentionProviders={mentionProviders}
      />
    )
    type("@agent:code-reviewer look")
    await act(async () => {
      submit()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // The agent dispatch path hits real discovery (no .cognia/agents → not
    // found), so the prompt carries an error block rather than crashing.
    await waitFor(() => expect(prompts.length).toBe(1))
    expect(prompts[0]).toContain('<agent id="code-reviewer"')
  })

  it("opens the permission overlay on a tool request and unblocks the turn when approved", async () => {
    let approved: unknown = null
    let resolved = false
    const create: CreateSession = () => ({
      sessionId: "ses-perm",
      async send(_prompt, opts) {
        // The dispatcher asks to run a tool; the turn is blocked until the
        // overlay resolves — exactly the real `permission_request` round-trip.
        approved = await opts.gate({
          toolName: "ls",
          displayName: "ls",
          input: { path: "." },
          requestId: "r1",
          sessionId: "s",
        } as never)
        resolved = true
        return result("done")
      },
      close: jest.fn(),
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("go")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // The overlay must appear and the turn stays blocked on it.
    await waitFor(() => expect(container.textContent).toContain("Allow ls"))
    expect(resolved).toBe(false)
    // Enter selects "Allow once" → the gate resolves → the turn proceeds.
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(approved).toEqual({ decision: "allow" }))
    expect(resolved).toBe(true)
  })

  it("persists an 'Allow always' choice and invalidates options", async () => {
    const persistToolApproval = jest.fn()
    const invalidate = jest.fn()
    const create: CreateSession = () => ({
      sessionId: "ses-perm2",
      async send(_prompt, opts) {
        await opts.gate({
          toolName: "mcp__cognia-tools__bash",
          displayName: "mcp__cognia-tools__bash",
          input: { command: "ls" },
          requestId: "r1",
          sessionId: "s",
        } as never)
        return result("done")
      },
      invalidateOptions: invalidate,
      close: jest.fn(),
    })
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        persistToolApproval={persistToolApproval}
      />
    )
    type("go")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Allow bash"))
    // Move to "Allow always" (index 1) and select it.
    act(() => __fireInput("", { downArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(persistToolApproval).toHaveBeenCalledWith("/home/u/.cognia", "mcp__cognia-tools__bash")
    )
    expect(invalidate).toHaveBeenCalled()
  })

  it("Ctrl+T expands collapsed tool output", async () => {
    const create: CreateSession = () => ({
      sessionId: "ses-tool",
      async send(_prompt, opts) {
        opts.onEvent?.({ type: "tool-call", toolName: "bash", input: { command: "ls" } })
        opts.onEvent?.({
          type: "tool-result",
          toolName: "bash",
          input: { command: "ls" },
          result: "SENTINEL_TOOL_OUTPUT",
        })
        return result("done")
      },
      close: jest.fn(),
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("run ls")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // The tool cell renders, but its result is collapsed (hidden) by default.
    await waitFor(() => expect(container.textContent).toContain("bash"))
    expect(container.textContent).not.toContain("SENTINEL_TOOL_OUTPUT")
    // Ctrl+T reveals all tool output (Ctrl+R now opens history search).
    act(() => __fireInput("t", { ctrl: true }))
    await waitFor(() => expect(container.textContent).toContain("SENTINEL_TOOL_OUTPUT"))
  })

  it("runs /clear to reset the transcript and wipe the terminal", async () => {
    const { create } = fakeSession("answer one")
    const clearScreen = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        mintId={() => "ses-2"}
        clearScreen={clearScreen}
      />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("answer one"))
    type("/clear")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // The terminal is wiped (Static scrollback won't clear itself) AND state reset.
    expect(clearScreen).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(container.textContent).not.toContain("answer one"))
  })

  it("runs /handoff and shows a notice", async () => {
    const { create } = fakeSession()
    const pushHandoff = jest.fn().mockResolvedValue(undefined)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} pushHandoff={pushHandoff} />
    )
    type("/handoff")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Pushed this session"))
    expect(pushHandoff).toHaveBeenCalledWith("s1")
  })

  it("reports an unknown command", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/bogus")
    submit()
    await waitFor(() => expect(container.textContent).toContain("Unknown command /bogus"))
  })

  it("notices when /plan refine is run with no plan to refine", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/plan refine")
    submit()
    await waitFor(() => expect(container.textContent).toContain("No plan to refine"))
  })

  it("exits on /exit", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    render(<App config={config} sessionId="s1" createSession={create} onExit={onExit} />)
    type("/exit")
    submit()
    expect(onExit).toHaveBeenCalled()
  })

  it("exits on a double Ctrl+C", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    render(
      <App config={config} sessionId="s1" createSession={create} onExit={onExit} now={() => 5000} />
    )
    act(() => __fireInput("c", { ctrl: true }))
    act(() => __fireInput("c", { ctrl: true }))
    expect(onExit).toHaveBeenCalled()
  })

  it("does not exit on a single Ctrl+C", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    let t = 0
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        onExit={onExit}
        now={() => (t += 5000)}
      />
    )
    act(() => __fireInput("c", { ctrl: true }))
    expect(onExit).not.toHaveBeenCalled()
  })

  it("shows an exit hint notice on the first Ctrl+C when idle", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} now={() => 1000} />
    )
    act(() => __fireInput("c", { ctrl: true }))
    expect(container.textContent).toContain("Press Ctrl+C again to exit")
  })

  it("exits on a second Ctrl+C within the 1s double-press window", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    let t = 1000
    render(
      <App config={config} sessionId="s1" createSession={create} onExit={onExit} now={() => t} />
    )
    // First press at t=1000.
    act(() => __fireInput("c", { ctrl: true }))
    // Second press at t=1500 — within the 1s window.
    t = 1500
    act(() => __fireInput("c", { ctrl: true }))
    expect(onExit).toHaveBeenCalled()
  })

  it("opens the help overlay on /help", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/help")
    submit()
    expect(container.textContent).toContain("Commands")
  })

  it("opens the usage panel on /usage", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/usage")
    submit()
    expect(container.textContent).toContain("Usage")
  })

  it("opens and applies the model switcher on /model", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/model")
    submit()
    expect(container.textContent).toContain("Switch model")
    act(() => __fireInput("", { return: true })) // select the only model
    expect(container.textContent).not.toContain("Switch model")
  })

  it("opens the mode switcher on /mode", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    // Trailing space closes the palette (`/mode` also prefix-matches `/model`).
    type("/mode ")
    submit()
    expect(container.textContent).toContain("Permission mode")
    expect(container.textContent).toContain("plan")
  })

  it("notes when no models are configured", () => {
    const { create } = fakeSession()
    // A provider with no shared catalog and no configured model → empty list.
    const bare: ResolvedConfig = {
      ...DEFAULT_RESOLVED_CONFIG,
      provider: "uncatalogued",
      cwd: "/work",
    }
    const { container } = render(<App config={bare} sessionId="s1" createSession={create} />)
    type("/model")
    submit()
    expect(container.textContent).toContain("No models configured")
  })

  it("browses and resumes a past session on /sessions", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
      />
    )
    type("/sessions")
    submit()
    expect(container.textContent).toContain("Resume session")
    expect(container.textContent).toContain("resumed question")
    await act(async () => {
      __fireInput("", { return: true }) // resume the highlighted session
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("cycles the permission mode on Shift+Tab", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    act(() => __fireInput("", { tab: true, shift: true }))
    // default → acceptEdits (first step of the PERMISSION_MODES cycle).
    expect(container.textContent).toContain("Permission mode: acceptEdits")
  })

  it("resumes the most recent session directly on /resume", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
      />
    )
    type("/resume")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("notices when there is nothing to resume on /resume", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} home="/home" readdir={() => []} />
    )
    type("/resume")
    submit()
    expect(container.textContent).toContain("No past sessions to resume.")
  })

  it("recalls the previous submission with the up arrow", async () => {
    const { create, prompts } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} />)
    type("alpha")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Composer is empty again; ↑ recalls "alpha", Enter re-sends it.
    act(() => __fireInput("", { upArrow: true }))
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).toEqual(["alpha", "alpha"])
  })

  it("re-sends the last message on /retry", async () => {
    const { create, prompts } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} />)
    type("first question")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/retry")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).toEqual(["first question", "first question"])
  })

  it("copies the last reply on /copy", async () => {
    const { create } = fakeSession("the reply text")
    const copyClipboard = jest.fn().mockResolvedValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} copyClipboard={copyClipboard} />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/copy")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(copyClipboard).toHaveBeenCalledWith("the reply text")
    await waitFor(() => expect(container.textContent).toContain("Copied the last reply"))
  })

  it("shows the working directory on /cwd", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/cwd")
    submit()
    expect(container.textContent).toContain("/work")
  })

  it("lists enabled built-in tools on /tools", () => {
    const { create } = fakeSession()
    const withTools: ResolvedConfig = {
      ...config,
      builtinTools: { ...config.builtinTools, git: true },
    }
    const { container } = render(<App config={withTools} sessionId="s1" createSession={create} />)
    type("/tools")
    submit()
    expect(container.textContent).toContain("git")
  })

  it("shows version + provider on /about", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/about")
    submit()
    expect(container.textContent).toContain("cognia-agent v")
    expect(container.textContent).toContain("anthropic")
  })

  it("renders streamed usage in the footer", async () => {
    const { create } = fakeSession("done", {
      inputTokens: 1000,
      outputTokens: 200,
      totalCostUsd: 0.5,
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Cost is accumulated from the streamed `usage` event, not left at $0.00.
    await waitFor(() => expect(container.textContent).toContain("$0.50"))
    expect(container.textContent).toContain("1.2k tok")
  })

  it("sizes context % to the catalog window and prices $0 turns from pricing", async () => {
    // ai-sdk path: streamed usage has 100k prompt tokens but no totalCostUsd.
    const { create } = fakeSession("done", { inputTokens: 100_000, outputTokens: 0 })
    const resolveMeta = jest.fn(async () => ({
      modelId: "claude-x",
      contextWindow: 1_000_000,
      pricing: { promptPer1M: 3, completionPer1M: 15 },
    }))
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} resolveMeta={resolveMeta} />
    )
    // Let the model-meta effect land before the turn so SET_USAGE can price it.
    await act(async () => {
      await Promise.resolve()
    })
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // 100k / 1M window = 10% (not 50% of the 200k fallback).
    await waitFor(() => expect(container.textContent).toContain("10% ctx"))
    // Cost estimated from catalog pricing: 100k × $3/1M = $0.30 (not $0.00).
    expect(container.textContent).toContain("$0.30")
    expect(resolveMeta).toHaveBeenCalledWith("anthropic", "claude-x")
  })

  it("opens the settings panel on /config", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={() => true} />
    )
    type("/config")
    submit()
    expect(container.textContent).toContain("Settings")
    expect(container.textContent).toContain("Provider")
    expect(container.textContent).toContain("Permission mode")
  })

  it("switches + persists the provider on /provider", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/provider")
    submit()
    expect(container.textContent).toContain("Switch provider")
    // anthropic is active + first; move down once to "openai" and select it.
    act(() => __fireInput("", { downArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("provider", "openai")
    // The unconfigured provider warns how to add a credential.
    await waitFor(() => expect(container.textContent).toContain("No credential"))
  })

  it("sets + persists the thinking level on /think (warns on a non-reasoning model)", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistPluginTools = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistPluginTools={persistPluginTools}
      />
    )
    type("/think")
    submit()
    expect(container.textContent).toContain("Effort")
    // Seeded off (no level set) at slider index 0. Tab to the slider, then move
    // right twice (low → medium → high), clearing off, and confirm.
    act(() => __fireInput("", { tab: true }))
    act(() => __fireInput("", { rightArrow: true }))
    act(() => __fireInput("", { rightArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("thinkingLevel", "high")
    // Not ultracode → the dynamic-workflow gate is persisted off.
    expect(persistPluginTools).toHaveBeenCalledWith(expect.any(String), false)
    // claude-x isn't a reasoning model → the level is saved with a warning.
    await waitFor(() => expect(container.textContent).toContain("doesn't support thinking levels"))
  })

  it("sets the thinking level without a warning on a reasoning-capable model", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistPluginTools = jest.fn()
    const { container } = render(
      <App
        config={{ ...config, model: "claude-opus-4-8" }}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistPluginTools={persistPluginTools}
      />
    )
    type("/effort")
    submit()
    // Seeded off at slider index 0 (low). Tab to the slider, left clears off and
    // clamps at low, then confirm → "low".
    act(() => __fireInput("", { tab: true }))
    act(() => __fireInput("", { leftArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("thinkingLevel", "low")
    expect(container.textContent).not.toContain("doesn't support thinking levels")
  })

  it("selecting ultracode persists the level and enables the dynamic-workflow gate", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const persistPluginTools = jest.fn()
    render(
      <App
        config={{ ...config, model: "claude-opus-4-8" }}
        sessionId="s1"
        createSession={create}
        persistConfig={persistConfig}
        persistPluginTools={persistPluginTools}
      />
    )
    type("/effort")
    submit()
    // Tab to the slider, then move right to the top tier (low→…→ultracode = 5 ticks).
    act(() => __fireInput("", { tab: true }))
    for (let i = 0; i < 6; i++) act(() => __fireInput("", { rightArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("thinkingLevel", "ultracode")
    expect(persistPluginTools).toHaveBeenCalledWith(expect.any(String), true)
  })

  it("drills from the settings panel into the provider switcher", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={() => true} />
    )
    type("/config")
    submit()
    // First row is Provider; Enter opens the provider switcher.
    act(() => __fireInput("", { return: true }))
    expect(container.textContent).toContain("Switch provider")
  })

  it("routes /goal with no objective to a usage notice", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistDb={() => {}} />
    )
    type("/goal")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Usage: /goal"))
  })

  it("routes /mcp to the no-servers notice when none are configured", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistDb={() => {}}
        home="/nonexistent-home"
      />
    )
    type("/mcp")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("No MCP servers"))
  })

  it("runs a !command shell-out and shows the output", async () => {
    const { create } = fakeSession()
    const runShell = jest.fn().mockResolvedValue({ stdout: "file-a\nfile-b", stderr: "", code: 0 })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("!ls")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(runShell).toHaveBeenCalledWith("ls", { cwd: "/work" })
    await waitFor(() => expect(container.textContent).toContain("file-a"))
  })

  it("lists the Cognia runtime commands in /help", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/help")
    submit()
    expect(container.textContent).toContain("Cognia")
    expect(container.textContent).toContain("/goal")
    expect(container.textContent).toContain("/workflow")
  })

  it("notes when there are no sessions to browse", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => []}
        transcriptFs={transcriptFs}
      />
    )
    type("/sessions")
    submit()
    expect(container.textContent).toContain("No past sessions")
  })

  it("applies + persists a status-bar theme on /statusbar theme", async () => {
    const { create } = fakeSession()
    const persistStatusBar = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home/u/.cognia"
        persistStatusBar={persistStatusBar}
      />
    )
    type("/statusbar theme dim")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(persistStatusBar).toHaveBeenCalledWith("/home/u/.cognia", { theme: "dim" })
    // The footer re-rendered with the dim theme (model now dimmed/gray, still shown).
    expect(container.textContent).toContain("claude-x")
  })

  it("opens the theme picker on a bare /statusbar", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/statusbar")
    submit()
    expect(container.textContent).toContain("Status-bar theme")
  })

  it("switches + persists the colour theme on /theme", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/theme dark")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("theme", "dark")
    expect(container.textContent).toContain("Theme: dark")
  })

  it("switches theme via the picker overlay", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/theme")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Move down to "dark" (index 1) and select it.
    act(() => __fireInput("", { downArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("theme", "dark")
  })

  it("keeps the colour theme after sending a turn", async () => {
    const { create } = fakeSession("the answer")
    const persistConfig = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/theme dark")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    persistConfig.mockClear()
    type("hello")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("the answer"))
    // Theme stayed dark: no second theme write happened, and the persisted config
    // key did not get clobbered back to classic.
    expect(persistConfig).not.toHaveBeenCalledWith("theme", expect.any(String))
  })

  it("opens the status panel on /status", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistDb={() => {}}
        home="/nonexistent-home"
      />
    )
    // Trailing space closes the palette (`/status` also prefix-matches `/statusbar`).
    type("/status ")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Status · cognia-agent"))
    expect(container.textContent).toContain("anthropic")
  })

  it("routes /loop to the streaming loop runner and queues a btw steer during the run", async () => {
    let loopDeps: Record<string, unknown> | undefined
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const startLoopRun = jest.fn(async (deps: Record<string, unknown>) => {
      loopDeps = deps
      await gate // keep the run active so runtimeAbort stays set
      ;(deps.dispatch as (a: unknown) => void)({
        type: "ACTIVITY_END",
        status: "done",
        summary: "Loop done.",
      })
    })
    const { create, prompts } = fakeSession("ok")
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        startLoopRun={startLoopRun as never}
      />
    )
    type("/loop 5m hello --n 2")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(startLoopRun).toHaveBeenCalledTimes(1))
    expect(loopDeps).toMatchObject({
      mode: "interval",
      prompt: "hello",
      intervalMs: 5 * 60_000,
      maxIterations: 2,
      sessionId: "s1",
    })

    // A message typed while the loop runs becomes a queued `btw` steer, not a send.
    type("check the logs")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).not.toContain("check the logs")
    await waitFor(() => expect(container.textContent).toContain("btw×1"))

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Loop done."))
  })

  it("routes /goal to the streaming goal runner with the objective", async () => {
    const startGoalRun = jest.fn(async (objective: string, deps: Record<string, unknown>) => {
      ;(deps.dispatch as (a: unknown) => void)({
        type: "ACTIVITY_END",
        status: "done",
        summary: `did: ${objective}`,
      })
    })
    const { create } = fakeSession("ok")
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        startGoalRun={startGoalRun as never}
      />
    )
    type("/goal ship the release")
    await act(async () => {
      submit()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(startGoalRun).toHaveBeenCalledWith(
        "ship the release",
        expect.objectContaining({ sessionId: "s1" })
      )
    )
    await waitFor(() => expect(container.textContent).toContain("did: ship the release"))
  })

  describe("plan mode", () => {
    const planConfig: ResolvedConfig = { ...config, permissionMode: "plan" }

    it("captures a plan-mode plan, persists it, and opens the approval prompt", async () => {
      const persistPlan = jest.fn(() => "/home/.cognia/plans/s1-plan-2.md")
      const { create } = fakeSession("# Plan\n- step one\n- step two")
      const { container } = render(
        <App
          config={planConfig}
          sessionId="s1"
          createSession={create}
          home="/home/.cognia"
          persistPlan={persistPlan}
        />
      )
      type("design it")
      await act(async () => {
        submit()
        await Promise.resolve()
      })
      await waitFor(() => expect(persistPlan).toHaveBeenCalled())
      expect(container.textContent).toContain("Proposed plan")
      expect(container.textContent).toContain("Plan ready for review")
      expect(container.textContent).toContain("/home/.cognia/plans/s1-plan-2.md")
      // The latest plan stays visible as a footer chip (open it with /plan).
      expect(container.textContent).toContain("📋")
    })

    it("approving the plan injects the proceed turn", async () => {
      const persistPlan = jest.fn(() => "/p.md")
      const { create, prompts } = fakeSession("## Approach\n1. a\n2. b")
      render(
        <App
          config={planConfig}
          sessionId="s1"
          createSession={create}
          home="/home/.cognia"
          persistPlan={persistPlan}
        />
      )
      type("plan it")
      await act(async () => {
        submit()
        await Promise.resolve()
      })
      await waitFor(() => expect(persistPlan).toHaveBeenCalled())
      // Enter at index 0 = approve.
      await act(async () => {
        __fireInput("", { return: true })
        await Promise.resolve()
      })
      const { PLAN_APPROVED_PROMPT } = jest.requireActual("../runtime/plan") as {
        PLAN_APPROVED_PROMPT: string
      }
      await waitFor(() => expect(prompts).toContain(PLAN_APPROVED_PROMPT))
    })

    it("does not prompt for a short clarifying reply in plan mode", async () => {
      const persistPlan = jest.fn(() => "/p.md")
      const { create } = fakeSession("Which file first?")
      const { container } = render(
        <App
          config={planConfig}
          sessionId="s1"
          createSession={create}
          home="/home/.cognia"
          persistPlan={persistPlan}
        />
      )
      type("ask me")
      await act(async () => {
        submit()
        await Promise.resolve()
      })
      expect(persistPlan).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain("Plan ready for review")
    })
  })

  // ── Startup onboarding (banner + trust gate) ───────────────────────────────
  describe("startup phase", () => {
    it("shows the welcome banner + trust gate when the folder is untrusted", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App config={config} sessionId="s1" createSession={create} trusted={false} />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("Cognia Agent")
      expect(text).toContain("Do you trust the files")
      expect(text).toContain("Yes, proceed")
    })

    it("trusts the folder and enters chat on 'Yes, proceed'", () => {
      const { create } = fakeSession()
      const trustFolderFn = jest.fn()
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          trusted={false}
          home="/home/u/.cognia"
          trustFolderFn={trustFolderFn}
        />
      )
      act(() => __fireInput("", { return: true }))
      expect(trustFolderFn).toHaveBeenCalledWith("/home/u/.cognia", "/work")
      expect(container.textContent ?? "").not.toContain("Do you trust the files")
    })

    it("switches the working directory from the startup folder picker", () => {
      const { create } = fakeSession()
      const trustFolderFn = jest.fn()
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          trusted={false}
          home="/home/u/.cognia"
          trustFolderFn={trustFolderFn}
          listDirs={() => ["pkg"]}
        />
      )
      // Move to "Choose another folder…", open the picker, confirm the folder.
      act(() => __fireInput("", { downArrow: true }))
      act(() => __fireInput("", { return: true }))
      act(() => __fireInput("", { return: true }))
      expect(trustFolderFn).toHaveBeenCalledWith("/home/u/.cognia", path.resolve("/work"))
      const text = container.textContent ?? ""
      expect(text).not.toContain("Choose a folder")
      expect(text).not.toContain("Do you trust the files")
    })
  })

  describe("Ctrl+R history search", () => {
    it("opens, refines, and loads a match into the composer on Enter", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          initialHistory={["git status", "ls -la /work", "git commit -m wip"]}
        />
      )
      // Open the reverse-i-search overlay.
      act(() => __fireInput("r", { ctrl: true }))
      expect(container.textContent).toContain("(reverse-i-search)")
      // Refine the query → most-recent match wins ("git commit …").
      act(() => __fireInput("git"))
      expect(container.textContent).toContain("git commit -m wip")
      // Ctrl+R cycles to the next-older "git" match.
      act(() => __fireInput("r", { ctrl: true }))
      expect(container.textContent).toContain("git status")
      // Enter loads the match into the composer and closes the overlay.
      act(() => __fireInput("", { return: true }))
      const text = container.textContent ?? ""
      expect(text).not.toContain("(reverse-i-search)")
      expect(text).toContain("git status")
    })

    it("shows a no-match hint and cancels on Esc", () => {
      const { create } = fakeSession()
      const { container } = render(
        <App config={config} sessionId="s1" createSession={create} initialHistory={["alpha"]} />
      )
      act(() => __fireInput("r", { ctrl: true }))
      act(() => __fireInput("z"))
      expect(container.textContent).toContain("(no match)")
      act(() => __fireInput("", { escape: true }))
      expect(container.textContent).not.toContain("(reverse-i-search)")
    })
  })

  describe("Ctrl+V clipboard image", () => {
    it("appends an @<path> mention and notices on a successful read", async () => {
      const { create } = fakeSession()
      const readClipboardImage = jest.fn(async () => ({ path: "/tmp/clip.png" }))
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          readClipboardImage={readClipboardImage}
        />
      )
      await act(async () => {
        __fireInput("v", { ctrl: true })
        await Promise.resolve()
      })
      const text = container.textContent ?? ""
      expect(readClipboardImage).toHaveBeenCalled()
      expect(text).toContain("@/tmp/clip.png")
      expect(text).toContain("image from clipboard")
    })

    it("notices when the clipboard holds no image", async () => {
      const { create } = fakeSession()
      const readClipboardImage = jest.fn(async () => null)
      const { container } = render(
        <App
          config={config}
          sessionId="s1"
          createSession={create}
          readClipboardImage={readClipboardImage}
        />
      )
      await act(async () => {
        __fireInput("v", { ctrl: true })
        await Promise.resolve()
      })
      expect(container.textContent).toContain("No image in clipboard")
    })
  })
})
