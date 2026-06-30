import React from "react"
import { render } from "@testing-library/react"

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
    overlayRows: 12,
    activeModel: "claude-x",
    home: "/home",
    resolvePermission: jest.fn(),
    persist: jest.fn(() => true),
    persistProviderModelFn: jest.fn(() => true),
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

  it("renders the permission-mode picker", () => {
    const { container } = wrap(
      <AppOverlays {...propsFor({ kind: "mode", options: ["default", "plan"], index: 0 })} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Permission mode")
    expect(text).toContain("plan")
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
