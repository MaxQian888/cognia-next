import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { externalCapabilities } from "../../runtime/backend-capabilities"
import { copyToClipboard } from "../../clipboard"
import { cancelCliBackgroundRun } from "../../../agent/subagent-background-tasks"
jest.mock("../../../agent/subagent-background-tasks", () => ({
  ...jest.requireActual("../../../agent/subagent-background-tasks"),
  cancelCliBackgroundRun: jest.fn(() => true),
}))
jest.mock("../../clipboard", () => ({
  ...jest.requireActual("../../clipboard"),
  copyToClipboard: jest.fn(async () => ({ ok: true })),
}))

import { AppOverlays, type AppOverlaysProps } from "./AppOverlays"
import { TuiInputProvider } from "../../input/input-router"
import { ThemeProvider } from "../../theme/context"
import { RenderPrefsProvider } from "../../render/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import { resolveRenderConfig } from "../../../config/schema"
import { createInitialState } from "../../state/initial"
import { bufferFromText } from "../../input/buffer"
import { DEFAULT_RESOLVED_CONFIG } from "../../../config/schema"
import type { ResolvedConfig } from "../../../config/schema"
import type { TuiState } from "../../state/types"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { AskUserOverlayApi } from "../../hooks/use-ask-user-overlay"
import { mcpRefreshSession, mcpApplySession, type McpDeps } from "../../runtime/mcp-controller"
jest.mock("../../runtime/mcp-controller", () => ({
  ...jest.requireActual("../../runtime/mcp-controller"),
  mcpRefreshSession: jest.fn(async () => {}),
  mcpApplySession: jest.fn(async () => {}),
}))

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

const agent = {
  switchModel: jest.fn(),
  switchMode: jest.fn(),
  switchProvider: jest.fn(),
  switchThinking: jest.fn(),
  invalidate: jest.fn(),
} as unknown as AgentSessionApi

const askUser = { resolve: jest.fn() } as unknown as AskUserOverlayApi

function propsFor(
  overlay: TuiState["overlay"],
  over: Partial<AppOverlaysProps> = {}
): AppOverlaysProps {
  const dispatch = jest.fn()
  return {
    state: { ...createInitialState(config, "s1", true, []), overlay },
    dispatch,
    agent,
    columns: 80,
    viewportRows: 18,
    activeModel: "claude-x",
    home: "/home",
    resolvePermission: jest.fn(),
    persist: jest.fn(() => true),
    persistProviderModelFn: jest.fn(() => true),
    persistBackendModelFn: jest.fn(() => true),
    persistCredentialFn: jest.fn(() => true),
    persistPluginTools: jest.fn(),
    applySettings: jest.fn(),
    activateSettings: jest.fn(),
    applySubagentModelEdit: jest.fn(),
    applyHistorySearch: jest.fn(),
    doResume: jest.fn(),
    runCommandLine: jest.fn(),
    submitForm: jest.fn(),
    onPlanDecision: jest.fn(),
    askUser,
    mcpPanelDeps: () => ({ dispatch, roots: ["/work"], home: "/home" }) as McpDeps,
    clearLogs: jest.fn(),
    ...over,
  }
}

const wrap = (el: React.ReactElement) =>
  render(
    <ThemeProvider palette={BUILTIN_THEMES.ansi}>
      <RenderPrefsProvider prefs={resolveRenderConfig(undefined)}>{el}</RenderPrefsProvider>
    </ThemeProvider>
  )

describe("AppOverlays", () => {
  it("opens the skill file tree and closes it through the overlay state", () => {
    const props = propsFor({
      kind: "skillFiles",
      title: "Nested skill",
      root: "/skills/demo",
      files: [],
    })
    const { container } = wrap(<AppOverlays {...props} />)
    expect(container.textContent).toContain("Nested skill")
    act(() => __fireInput("", { escape: true }))
    expect(props.dispatch).toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
  })

  it("stops a background agent in the owning session from the agents panel", () => {
    const props = propsFor({
      kind: "agents",
      rows: [
        {
          id: "bg:run-1",
          kind: "background",
          name: "reviewer",
          task: "review",
          status: "running",
          runId: "run-1",
        },
      ],
    })
    wrap(<AppOverlays {...props} />)
    act(() => __fireInput("s", {}))
    expect(cancelCliBackgroundRun).toHaveBeenCalledWith("run-1", "s1")
  })

  it.each([false, new Error("transport closed")])(
    "reports an unavailable native stop: %s",
    async (outcome) => {
      const stopTask = jest.fn(async () => {
        if (outcome instanceof Error) throw outcome
        return outcome
      })
      const props = propsFor(
        {
          kind: "agents",
          rows: [
            {
              id: "native-1",
              kind: "inflight",
              name: "reviewer",
              task: "review",
              status: "running",
              runtimeTaskId: "task-1",
            },
          ],
        },
        { agent: { ...agent, stopTask } }
      )
      wrap(<AppOverlays {...props} />)
      await act(async () => __fireInput("s", {}))
      expect(stopTask).toHaveBeenCalledWith("task-1")
      expect(props.dispatch).toHaveBeenCalledWith({
        type: "NOTICE",
        message:
          outcome instanceof Error
            ? "Could not stop agent: Error: transport closed"
            : "No active agent task to stop.",
      })
    }
  )

  it("renders nothing when no overlay is open", () => {
    const { container } = wrap(<AppOverlays {...propsFor({ kind: "none" })} />)
    expect((container.textContent ?? "").trim()).toBe("")
  })

  it("renders the help overlay", () => {
    const { container } = wrap(<AppOverlays {...propsFor({ kind: "help" })} />)
    // The help panel lists keyboard shortcuts; assert it produced output.
    expect((container.textContent ?? "").length).toBeGreaterThan(0)
  })

  it("renders a document overlay with its title + body", () => {
    const { container } = wrap(
      <AppOverlays
        {...propsFor({ kind: "document", title: "My Doc", body: "hello body", format: "text" })}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("My Doc")
    expect(text).toContain("hello body")
  })

  it("lists live image attachments from the draft and dispatches removal", () => {
    const base = createInitialState(config, "s1", true, [])
    const props = propsFor(
      { kind: "attachments" },
      {
        state: {
          ...base,
          overlay: { kind: "attachments" },
          input: {
            ...base.input,
            buffer: bufferFromText("look [Image 1] and [Image 2]"),
            pastes: {
              "[Image 1]": '@"/tmp/one.png"',
              "[Image 2]": '@"/tmp/two.png"',
            },
          },
        },
      }
    )
    const { container } = wrap(<AppOverlays {...props} />)
    const text = container.textContent ?? ""
    expect(text).toContain("[Image 1]")
    expect(text).toContain("/tmp/one.png")
    expect(text).toContain("/tmp/two.png")
    // `d` drops the highlighted row through the undoable reducer action.
    act(() => __fireInput("d", {}))
    expect(props.dispatch).toHaveBeenCalledWith({
      type: "INPUT_REMOVE_IMAGES",
      labels: ["[Image 1]"],
    })
    act(() => __fireInput("c", {}))
    expect(props.dispatch).toHaveBeenCalledWith({
      type: "INPUT_REMOVE_IMAGES",
      labels: ["[Image 1]", "[Image 2]"],
    })
    act(() => __fireInput("", { escape: true }))
    expect(props.dispatch).toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
  })

  it("renders the model picker with the filtered options", () => {
    const { container } = wrap(
      <AppOverlays
        {...propsFor({ kind: "model", options: ["model-a", "model-b"], index: 0, query: "" })}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Switch model")
    expect(text).toContain("model-a")
  })

  it("renders an external display label but selects the underlying model id", () => {
    ;(agent.switchModel as jest.Mock).mockClear()
    const props = propsFor({
      kind: "model",
      options: ["gpt-5.6-sol"],
      labels: { "gpt-5.6-sol": "GPT-5.6 Sol (gpt-5.6-sol)" },
      index: 0,
      query: "",
    })
    const { container } = wrap(<AppOverlays {...props} />)

    expect(container.textContent).toContain("GPT-5.6 Sol (gpt-5.6-sol)")
    act(() => __fireInput("", { return: true }))
    expect(agent.switchModel).toHaveBeenCalledWith("gpt-5.6-sol")
  })

  it("filters the model list by the typeahead query", () => {
    const { container } = wrap(
      <AppOverlays
        {...propsFor({ kind: "model", options: ["alpha", "beta"], index: 0, query: "bet" })}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("beta")
    expect(text).not.toContain("alpha")
  })

  it.each([true, false])(
    "uses live external thinking capability (%s) instead of the builtin provider",
    (supported) => {
      const overlay = { kind: "effortSlider", off: false, index: 0 } as const
      const caps = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
      caps.features.thinking = { supported }
      const props = propsFor(overlay, {
        state: {
          ...createInitialState({ ...config, agentBackend: "codex" }, "s1", true, []),
          overlay,
          backendCapabilities: caps,
        },
        activeModel: "native-model",
      })
      const { container } = wrap(<AppOverlays {...props} />)
      expect(container.textContent?.includes("doesn't support")).toBe(!supported)
      act(() => __fireInput("", { return: true }))
      expect(props.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "BACKEND_CONNECT_RETRY" })
      )
      const notices = (props.dispatch as jest.Mock).mock.calls.filter(
        ([action]) => action.type === "NOTICE"
      )
      expect(notices.some(([action]) => action.message.includes("doesn't support thinking"))).toBe(
        !supported
      )
    }
  )

  it("offers only the session's own rungs and lands the picked variant on Devin", async () => {
    // swe-2-* publishes `medium | high | max` — the slider must neither show
    // nor resolve a `low`/`xhigh` rung the family does not have.
    const overlay: TuiState["overlay"] = {
      kind: "effortSlider",
      off: false,
      index: 1,
      levels: ["medium", "high", "max"],
    }
    const caps = externalCapabilities({ backend: "devin", presetId: "devin" })
    const applyThinkingLevel = jest.fn(async () => "swe-2-high")
    const devinAgent = { ...agent, applyThinkingLevel } as unknown as AgentSessionApi
    const props = propsFor(overlay, {
      agent: devinAgent,
      columns: 100,
      state: {
        ...createInitialState({ ...config, agentBackend: "devin" }, "s1", true, []),
        overlay,
        backendCapabilities: caps,
      },
      activeModel: "swe-2-max",
    })
    const { container } = wrap(<AppOverlays {...props} />)
    const text = container.textContent ?? ""
    // The wide scale renders exactly the family's rungs — nothing the model
    // does not publish (no `xhigh`, no `ultracode`, no phantom `low` rung on a
    // swe-2-* ladder that starts at medium).
    expect(text).toContain("medium")
    expect(text).toContain("high")
    expect(text).toContain("max")
    expect(text).not.toContain("xhigh")
    expect(text).not.toContain("ultracode")

    act(() => __fireInput("", { return: true }))
    // Index 1 into the OFFERED ladder → "high", not position 1 of the global
    // ladder (which would be "medium"… and would be a different model family).
    expect(props.persist).toHaveBeenCalledWith("thinkingLevel", "high")

    // The live write runs BEFORE switchThinking drops the session, and the
    // landed variant is persisted + dispatched so the footer names the truth.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(applyThinkingLevel).toHaveBeenCalledWith("high")
    expect(props.persistBackendModelFn).toHaveBeenCalledWith("devin", "swe-2-high")
    expect(props.dispatch).toHaveBeenCalledWith({ type: "SET_MODEL", model: "swe-2-high" })
    expect(devinAgent.switchThinking).toHaveBeenCalledWith("high", false)
    // A per-session write already landed — restarting the whole backend would
    // only kill the conversation the write applied to.
    expect(props.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "BACKEND_CONNECT_RETRY" })
    )
  })

  it("still reconnects Codex, which reads effort at registration", async () => {
    const overlay = { kind: "effortSlider", off: false, index: 2 } as const
    const caps = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
    const applyThinkingLevel = jest.fn(async () => undefined)
    const codexAgent = { ...agent, applyThinkingLevel } as unknown as AgentSessionApi
    const props = propsFor(overlay, {
      agent: codexAgent,
      state: {
        ...createInitialState({ ...config, agentBackend: "codex" }, "s1", true, []),
        overlay,
        backendCapabilities: caps,
      },
      activeModel: "gpt-5.6-codex",
    })
    wrap(<AppOverlays {...props} />)
    act(() => __fireInput("", { return: true }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // Codex's variant-less surface answers undefined — nothing to persist.
    expect(props.persistBackendModelFn).not.toHaveBeenCalled()
    expect(props.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "BACKEND_CONNECT_RETRY" })
    )
  })

  it("copies documents with the configured clipboard strategy", async () => {
    const overlay = {
      kind: "document",
      title: "Transcript",
      body: "complete body",
      format: "text",
    } as const
    const props = propsFor(overlay, {
      state: {
        ...createInitialState(
          { ...config, clipboard: { osc52: "always", osc52MaxBytes: 42 } },
          "s1",
          true,
          []
        ),
        overlay,
      },
    })
    wrap(<AppOverlays {...props} />)
    await act(async () => {
      __fireInput("y")
      await Promise.resolve()
    })
    expect(copyToClipboard).toHaveBeenCalledWith("complete body", {
      osc52: "always",
      osc52MaxBytes: 42,
    })
  })

  it("uses the injected writer for document copying", async () => {
    const copyClipboard = jest.fn(async () => ({ ok: true as const }))
    const props = propsFor(
      { kind: "document", title: "Transcript", body: "injected body", format: "text" },
      { copyClipboard }
    )
    wrap(<AppOverlays {...props} />)
    await act(async () => {
      __fireInput("y")
      await Promise.resolve()
    })
    expect(copyClipboard).toHaveBeenCalledWith("injected body")
    expect(props.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "NOTICE",
        message: "Copied the complete document to the clipboard.",
      })
    )
  })

  it("renders the provider picker and filters it by the typeahead query", () => {
    const options = [
      { id: "anthropic", name: "Anthropic", configured: true, auth: "api key", requiresKey: true },
      { id: "openai", name: "OpenAI", configured: false, auth: "no credential", requiresKey: true },
    ]
    const { container } = wrap(
      <AppOverlays {...propsFor({ kind: "provider", options, index: 0, query: "openai" })} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Switch provider")
    expect(text).toContain("OpenAI")
    expect(text).toContain("not configured")
    expect(text).not.toContain("Anthropic")
  })

  it("returns from workspace browsing to the originating settings row", () => {
    const props = propsFor({
      kind: "workspaceFolder",
      mode: "cwd",
      returnToSettings: { section: 10, index: 0 },
    })
    wrap(<AppOverlays {...props} />)
    act(() => {
      __fireInput("", { escape: true })
    })
    expect(props.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "OVERLAY_OPEN",
        overlay: expect.objectContaining({ kind: "settings", section: 10, index: 0 }),
      })
    )
  })

  it("returns from the provider picker to the originating settings row", () => {
    const props = propsFor({
      kind: "provider",
      options: [
        {
          id: "anthropic",
          name: "Anthropic",
          configured: true,
          auth: "api key",
          requiresKey: true,
        },
      ],
      index: 0,
      query: "",
      returnToSettings: { section: 2, index: 3 },
    })
    wrap(<AppOverlays {...props} />)

    act(() => __fireInput("", { escape: true }))

    expect(props.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "OVERLAY_OPEN",
        overlay: expect.objectContaining({ kind: "settings", section: 2, index: 3 }),
      })
    )
  })

  it("returns from a settings credential editor to the originating settings row", () => {
    const props = propsFor({
      kind: "providerKey",
      providerId: "deepseek",
      providerName: "DeepSeek",
      credentialKind: "apiKey",
      value: "sk-existing",
      reveal: false,
      existing: true,
      returnToSettings: { section: 0, index: 1 },
    })
    wrap(<AppOverlays {...props} />)

    act(() => __fireInput("", { escape: true }))

    expect(props.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "OVERLAY_OPEN",
        overlay: expect.objectContaining({ kind: "settings", section: 0, index: 1 }),
      })
    )
  })

  it("saves a built-in provider preference without restarting a hosted external agent", () => {
    ;(agent.switchProvider as jest.Mock).mockClear()
    const overlay = {
      kind: "provider" as const,
      options: [
        {
          id: "ollama",
          name: "Ollama",
          configured: false,
          auth: "no credential",
          requiresKey: false,
        },
      ],
      index: 0,
      query: "",
    }
    const props = propsFor(overlay)
    props.state = {
      ...props.state,
      config: { ...props.state.config, agentBackend: "codex" },
    }
    wrap(<AppOverlays {...props} />)
    act(() => __fireInput("", { return: true }))
    expect(agent.switchProvider).not.toHaveBeenCalled()
    expect(props.dispatch).toHaveBeenCalledWith({ type: "SET_PROVIDER", provider: "ollama" })
    expect(props.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "NOTICE",
        message: expect.stringContaining("active codex backend is unchanged"),
      })
    )
  })

  it("saves a DeepSeek credential without restarting the active Claude Code backend", () => {
    ;(agent.switchProvider as jest.Mock).mockClear()
    const props = propsFor({
      kind: "providerKey",
      providerId: "deepseek",
      providerName: "DeepSeek",
      credentialKind: "apiKey",
      value: "sk-deepseek",
      reveal: false,
      existing: true,
    })
    props.state = {
      ...props.state,
      config: {
        ...props.state.config,
        agentBackend: "claude-code",
        providers: { ...props.state.config.providers, deepseek: { apiKey: "sk-deepseek" } },
      },
    }

    wrap(<AppOverlays {...props} />)
    act(() => __fireInput("", { return: true }))

    expect(agent.switchProvider).not.toHaveBeenCalled()
    expect(props.dispatch).toHaveBeenCalledWith({ type: "SET_PROVIDER", provider: "deepseek" })
    expect(props.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "NOTICE",
        message: expect.stringContaining("active claude-code backend is unchanged"),
      })
    )
  })

  it("renders the inline provider key prompt, masked", () => {
    const { container } = wrap(
      <AppOverlays
        {...propsFor({
          kind: "providerKey",
          providerId: "openai",
          providerName: "OpenAI",
          credentialKind: "apiKey",
          value: "sk-abc",
          reveal: false,
        })}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Add API key for OpenAI")
    expect(text).toContain("••••••")
    expect(text).not.toContain("sk-abc")
  })

  it("renders the permission-mode picker, marking the no-guardrails row", () => {
    const { container } = wrap(
      <AppOverlays
        {...propsFor({
          kind: "mode",
          options: ["default", "plan", "bypassPermissions"],
          index: 0,
        })}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Permission mode")
    expect(text).toContain("plan")
    expect(text).toContain("⚠ bypass")
  })

  it("routes a mode pick through /mode so the acknowledgement can't be skipped", () => {
    // Picking straight into `agent.switchMode` here would make this picker the
    // one entry point that bypasses the danger-tier confirm.
    const props = propsFor({ kind: "mode", options: ["default", "bypassPermissions"], index: 1 })
    wrap(<AppOverlays {...props} />)
    act(() => __fireInput("", { return: true }))
    expect(props.runCommandLine).toHaveBeenCalledWith("/mode bypassPermissions")
    expect(agent.switchMode).not.toHaveBeenCalled()
  })

  it("renders a generic select list", () => {
    const { container } = wrap(
      <AppOverlays
        {...propsFor({
          kind: "select",
          title: "Pick one",
          items: [{ id: "a", label: "Apple" }],
          index: 0,
        })}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Pick one")
    expect(text).toContain("Apple")
  })

  it.each([
    [0, "/mode bypassPermissions --force"],
    [1, "/mode bypassPermissions --force --remember"],
    [2, "/mode default"],
  ])("routes bypass choice %s to its distinct command", (selection, expected) => {
    const props = propsFor({
      kind: "confirm",
      title: "Bypass?",
      body: "Review permission mode",
      format: "text",
      onConfirmCommand: "mode bypassPermissions --force",
      onRememberCommand: "mode bypassPermissions --force --remember",
      onCancelCommand: "mode default",
    })
    wrap(<AppOverlays {...props} />)
    for (let i = 0; i < selection; i++) act(() => __fireInput("", { downArrow: true }))
    act(() => __fireInput("", { return: true }))
    expect(props.dispatch).toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
    expect(props.runCommandLine).toHaveBeenCalledWith(expected)
  })

  it("renders a confirm overlay", () => {
    const { container } = wrap(
      <AppOverlays
        {...propsFor({
          kind: "confirm",
          title: "Delete?",
          body: "are you sure",
          format: "markdown",
          onConfirmCommand: "x",
          onCancelCommand: "y",
        })}
      />
    )
    expect(container.textContent ?? "").toContain("Delete?")
  })
})

function fireKey(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

describe("AppOverlays — unified log panel wiring", () => {
  beforeEach(() => __resetInk())

  const rows = [
    {
      id: "a1",
      ts: 1,
      level: "error" as const,
      channel: "agent" as const,
      message: "spawn failed",
    },
  ]
  const mcp = [
    { id: "m1", ts: 2, level: "info" as const, source: "stderr" as const, message: "mcp line" },
  ]

  function logProps() {
    const p = propsFor({ kind: "logs" })
    return { ...p, state: { ...p.state, logs: rows, mcpLogs: mcp } }
  }

  it("renders the LogPanel, merging state.logs with a projection of state.mcpLogs", () => {
    const { container } = wrap(<AppOverlays {...logProps()} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Logs · 2")
    expect(text).toContain("spawn failed")
    // MCP rows are projected at READ time — they are never stored in state.logs.
    expect(text).toContain("mcp line")
    expect(text).toContain("[mcp/stderr]")
  })

  it("Enter injects in the load-bearing order: close BEFORE the edit", () => {
    const props = logProps()
    const { container } = wrap(<AppOverlays {...props} />)
    expect(container.textContent).toContain("Logs ·")
    ;(props.dispatch as jest.Mock).mockClear()
    fireKey("", { return: true })
    const types = (props.dispatch as jest.Mock).mock.calls.map((c) => c[0].type)
    // OVERLAY_CLOSE must come first: it restores `savedCursor` whenever that is
    // merely in range, so closing after the edit would drag the caret to the
    // front of the injected block.
    expect(types).toEqual(["OVERLAY_CLOSE", "INPUT_EDIT", "NOTICE"])
  })

  it("Ctrl+L clears through the ingest owner so pending coalesced lines are dropped", () => {
    const props = logProps()
    wrap(<AppOverlays {...props} />)

    fireKey("l", { ctrl: true })

    expect(props.clearLogs).toHaveBeenCalledTimes(1)
    expect(props.dispatch).not.toHaveBeenCalledWith({ type: "LOG_CLEAR" })
  })
})

describe("AppOverlays git review and command availability", () => {
  beforeEach(() => {
    __resetInk()
    jest.mocked(copyToClipboard).mockResolvedValue({ ok: true })
  })
  const review = {
    files: [{ path: "new.ts", staged: "", unstaged: "", untracked: "+entire new file" }],
  }
  const renderReview = (props: AppOverlaysProps) =>
    wrap(
      <TuiInputProvider>
        <AppOverlays {...props} />
      </TuiInputProvider>
    )

  it("shows loading and refuses duplicate refresh while allowing close", () => {
    const props = propsFor({ kind: "gitDiff", requestId: 1, loading: true, review })
    const { container } = renderReview(props)
    expect(container.textContent).toContain("Working")
    expect(container.textContent).toContain("new.ts")
    fireKey("r")
    expect(props.runCommandLine).not.toHaveBeenCalled()
    fireKey("", { escape: true })
    expect(props.dispatch).toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
  })

  it.each([undefined, "origin/main"])(
    "refreshes the same comparison (%s) after a displayed error",
    (baseRef) => {
      const props = propsFor({
        kind: "gitDiff",
        requestId: 1,
        loading: false,
        error: "git access denied",
        review: { ...review, ...(baseRef ? { baseRef } : {}) },
      })
      const { container } = renderReview(props)
      expect(container.textContent).toContain("Could not load changes: git access denied")
      expect(container.textContent).not.toContain("Working")
      fireKey("r")
      expect(props.runCommandLine).toHaveBeenCalledWith(baseRef ? "/diff origin/main" : "/diff")
    }
  )

  it.each([true, false])(
    "copies full selected patch and reports the clipboard outcome (%s)",
    async (ok) => {
      const copyClipboard = jest.fn(async () =>
        ok ? { ok: true as const } : { ok: false as const, reason: "unavailable" as const }
      )
      const props = propsFor({ kind: "gitDiff", requestId: 1, review }, { copyClipboard })
      renderReview(props)
      fireKey("", { return: true })
      await act(async () => __fireInput("y", {}))
      expect(copyClipboard).toHaveBeenCalledWith("+entire new file")
      expect(props.dispatch).toHaveBeenCalledWith({
        type: "NOTICE",
        message: ok
          ? "Copied the complete document to the clipboard."
          : "Couldn't copy the document to the clipboard.",
      })
    }
  )

  it("uses the configured clipboard helper when no injected copy callback exists", async () => {
    const props = propsFor({ kind: "gitDiff", requestId: 1, review })
    props.state.config = {
      ...props.state.config,
      clipboard: { osc52: "never", osc52MaxBytes: 1024 },
    }
    renderReview(props)
    fireKey("", { return: true })
    await act(async () => __fireInput("y", {}))
    expect(copyToClipboard).toHaveBeenCalledWith("+entire new file", {
      osc52: "never",
      osc52MaxBytes: 1024,
    })
  })

  it("keeps an unavailable contextual command visible and refuses its selection", () => {
    const props = propsFor({
      kind: "quickActions",
      index: 0,
      query: "",
      rows: [
        {
          id: "model",
          label: "Select model",
          command: "/model",
          disabledReason: "Backend does not support model selection",
        },
      ],
    })
    const { container } = renderReview(props)
    expect(container.textContent).toContain("Backend does not support model selection")
    fireKey("", { return: true })
    expect(props.runCommandLine).not.toHaveBeenCalled()
    expect(props.dispatch).not.toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
  })
})

it("gives settings the full measured viewport and grows the visible row window on taller terminals", () => {
  const props = propsFor(
    {
      kind: "settings",
      section: 0,
      index: 0,
      sections: [
        {
          id: "advanced",
          title: "Advanced",
          rows: Array.from({ length: 40 }, (_, index) => ({
            id: `row-${index}`,
            label: `setting-row-${String(index).padStart(2, "0")}`,
            value: "value",
            description: "Focused setting details",
            control: { type: "readonly" as const },
          })),
        },
      ],
    },
    { viewportRows: 14 }
  )
  const tree = (viewportRows: number) => <AppOverlays {...props} viewportRows={viewportRows} />
  const { container, rerender } = render(tree(14))
  const shortCount = (container.textContent?.match(/setting-row-\d+/g) ?? []).length
  expect(shortCount).toBeGreaterThan(0)
  expect(shortCount).toBeLessThan(10)
  rerender(tree(34))
  const tallCount = (container.textContent?.match(/setting-row-\d+/g) ?? []).length
  expect(tallCount).toBeGreaterThan(shortCount + 10)
  expect(tallCount).toBeLessThan(40)
})

describe("AppOverlays MCP runtime actions", () => {
  beforeEach(() => {
    __resetInk()
    jest.clearAllMocks()
  })
  it("wires refresh and apply to the current session dependencies", () => {
    const props = propsFor({ kind: "mcp", servers: [], probing: false, runtimeBackend: "pi-rpc" })
    const { container } = wrap(<AppOverlays {...props} />)
    expect(container.textContent).toContain("Session: pi-rpc")
    act(() => __fireInput("r", { ctrl: true }))
    expect(mcpRefreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ dispatch: props.dispatch })
    )
    act(() => __fireInput("a", { ctrl: true }))
    expect(mcpApplySession).toHaveBeenCalledWith(
      expect.objectContaining({ dispatch: props.dispatch })
    )
  })
})

it("wires the hooks inventory to settings, source editing and reload commands", () => {
  const props = propsFor({
    kind: "hooks",
    diagnostics: [],
    rows: [
      {
        id: "builtin:test",
        builtinId: "test",
        source: "builtin",
        event: "PreToolUse",
        label: "test",
        enabled: true,
        detail: "example",
      },
    ],
  })
  wrap(
    <TuiInputProvider>
      <AppOverlays {...props} />
    </TuiInputProvider>
  )
  act(() => __fireInput(" ", {}))
  expect(props.applySettings).toHaveBeenCalledWith({ kind: "hook", id: "test" }, false)
  act(() => __fireInput("e", { ctrl: true }))
  expect(props.runCommandLine).toHaveBeenCalledWith("/open /home/config.json")
  act(() => __fireInput("r", { ctrl: true }))
  expect(props.runCommandLine).toHaveBeenCalledWith("/hooks refresh")
})

it("updates a bash output document as its source emits output and exits", () => {
  const props = propsFor({
    kind: "document",
    title: "old title",
    body: "old snapshot",
    format: "text",
    sourceBashId: "job",
  })
  props.state.cells = [
    {
      id: "job",
      kind: "bash",
      command: "watch",
      status: "running",
      output: "first output",
      background: true,
    },
  ]
  const { container, rerender } = wrap(<AppOverlays {...props} />)
  expect(container.textContent).toContain("first output")
  expect(container.textContent).not.toContain("old snapshot")
  props.state = {
    ...props.state,
    cells: [
      {
        id: "job",
        kind: "bash",
        command: "watch",
        status: "done",
        output: "first output\nlast output",
        exitCode: 0,
      },
    ],
  }
  rerender(<AppOverlays {...props} />)
  expect(container.textContent).toContain("last output")
  expect(container.textContent).toContain("exit 0")
})
