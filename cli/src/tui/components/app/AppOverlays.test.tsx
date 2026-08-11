import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { AppOverlays, type AppOverlaysProps } from "./AppOverlays"
import { ThemeProvider } from "../../theme/context"
import { RenderPrefsProvider } from "../../render/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import { resolveRenderConfig } from "../../../config/schema"
import { createInitialState } from "../../state/initial"
import { DEFAULT_RESOLVED_CONFIG } from "../../../config/schema"
import type { ResolvedConfig } from "../../../config/schema"
import type { TuiState } from "../../state/types"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { AskUserOverlayApi } from "../../hooks/use-ask-user-overlay"
import type { McpDeps } from "../../runtime/mcp-controller"

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
    openModelPicker: jest.fn(),
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
