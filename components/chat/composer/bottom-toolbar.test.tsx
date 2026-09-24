/**
 * @jest-environment jsdom
 */

import { WebStatusProvider } from "@/components/shell/web-status"

jest.mock("@/components/shell/use-bar-layout", () => ({
  useBarLayout: () => ({
    resolved: {
      zones: {
        start: [{ id: "connectivity" }],
        center: [{ id: "runStatus" }],
        end: [],
      },
    },
  }),
}))
jest.mock("@/components/desktop/status-bar-zone", () => ({
  StatusBarZone: ({ items }: { items: { id: string }[] }) =>
    items.map(({ id }) => <span key={id} data-testid={`segment-${id}`} />),
}))
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { useChatExecutor } from "@/components/agent/composition/use-chat-executor"
import { BottomToolbar, TOOLBAR_CHIP } from "./bottom-toolbar"
import {
  clearAllMockExtensions,
  registerMockExtension,
} from "@/components/plugins/test-utils/register-mock-extension"
import { CHROME_BUDGET, countControls } from "@/lib/ui/chrome-budget"
import type { ChatSession } from "@cognia/agent-config-types"

// Mock next-intl translations.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Drive the measured-width responsive switch deterministically (jsdom has no
// layout, so the real hook would always report 0 = wide).
let mockToolbarWidth = 0
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => mockToolbarWidth,
}))

// Capture router.push calls.
const pushSpy = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
}))

// Stub the heavier sibling components — we only care about props.
const lastSelectorProps: Record<string, unknown> = {}
jest.mock("@/components/agent/composition/use-chat-executor", () => ({
  useChatExecutor: jest.fn(() => ({})),
}))
jest.mock("@/components/agent/composition/composition-chip", () => ({
  CompositionChip: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="composition-chip" data-layout={String(props.layout)} />
  },
}))
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return (
      <div data-testid="agent-runtime-selector" data-dense={props.dense ? "true" : undefined} />
    )
  },
}))
// The sandbox indicator now renders inline on the wide row, so it mounts in
// every render here. It reads the character record through Dexie — stub the
// live query rather than standing up a database for a status glyph.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}))
jest.mock("../permission-mode-indicator", () => ({
  // Mirrors the chip styling onto the stub: the row's shrink policy is a
  // per-control decision, and `lastSelectorProps` only remembers whichever
  // stub rendered last.
  PermissionModeIndicator: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return (
      <div
        data-testid="permission-mode-indicator"
        className={String(props.className ?? "")}
        data-glyph={props.glyph ? "true" : undefined}
      />
    )
  },
}))
jest.mock("./web-search-toggle", () => ({
  WebSearchToggle: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="web-search-toggle" />
  },
}))
jest.mock("./effort-selector", () => ({
  EffortSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="effort-selector" />
  },
}))
// EnhanceButton needs the composer controller context; stub it (and the
// controller hook) so these prop-branching tests don't require a provider.
jest.mock("./enhance-button", () => ({
  EnhanceButton: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="enhance-button" />
  },
}))
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputController: () => ({ textInput: { value: "", setInput: jest.fn() } }),
}))
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/components/ai-elements/context", () => ({
  Context: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextTrigger: () => null,
  ContextContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextContentHeader: () => null,
  ContextContentBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextContentFooter: () => null,
  ContextInputUsage: () => null,
  ContextOutputUsage: () => null,
  ContextCacheUsage: () => null,
}))

// Agent store state — mutated by tests that need a different lane or mode.
let agentRuntimeState = {
  runtimeRef: { kind: "builtin" } as { kind: string; agentId?: string },
  modeId: "general" as string,
  setModeId: jest.fn(),
}

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: <T,>(selector: (s: typeof agentRuntimeState) => T) =>
    selector(agentRuntimeState),
}))
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => agentRuntimeState.runtimeRef,
}))

let chatStoreState = {
  messages: [] as unknown[],
  status: "idle" as string,
  setPermissionMode: jest.fn(),
}

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T,>(selector: (s: typeof chatStoreState) => T) => selector(chatStoreState),
    { getState: () => chatStoreState }
  ),
  // `useSdkContextUsage` reads the per-session status through this selector.
  useSessionStatus: () => chatStoreState.status,
}))

// The shipped default (`PROVIDERS.anthropic.defaultModel`), so the budget below
// measures the roster a stock install actually renders. It matters here because
// the thinking-level chip self-hides on a model with no depth ladder — pinning
// this to an effort-incapable id would quietly under-count the band.
let mockDefaultModel = "claude-sonnet-5"
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: { defaultModel: string } | null }) => T) =>
    selector({ settings: { defaultModel: mockDefaultModel } }),
}))

const session: ChatSession = {
  id: "s1",
  title: "Test",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  characterId: "c1",
}

beforeEach(() => {
  mockDefaultModel = "claude-sonnet-5"
  ;(useChatExecutor as jest.Mock).mockReturnValue({})
  pushSpy.mockClear()
  chatStoreState = {
    messages: [],
    status: "idle",
    setPermissionMode: jest.fn(),
  }
  agentRuntimeState = {
    runtimeRef: { kind: "builtin" },
    modeId: "general",
    setModeId: jest.fn(),
  }
  for (const key of Object.keys(lastSelectorProps)) delete lastSelectorProps[key]
  mockToolbarWidth = 0
})

// Stub the workflow toolbar variant so the branching test doesn't need
// the full workflow context tree.
// The three session-shape / session-status pieces that moved down from the
// chat header. Each is covered by its own suite; here they are stubs so this
// file keeps testing the toolbar's packing, not their data plumbing.
// In the shipped default state the preset chip (no presets) and the credential
// badge (a key is configured) render nothing; only the cost badge is on screen.
// The stubs mirror that so the chrome budget below measures what users get.
let movedControlsVisible = false
jest.mock("./preset-chip", () => ({
  ComposerPresetChip: ({ className }: { className?: string }) =>
    movedControlsVisible ? <div data-testid="composer-preset-chip" className={className} /> : null,
}))
jest.mock("./credential-badge", () => ({
  ComposerCredentialBadge: (props: { glyph?: boolean }) =>
    movedControlsVisible ? (
      <div data-testid="composer-credential-badge" data-glyph={props.glyph ? "true" : undefined} />
    ) : null,
}))
jest.mock("@/components/chat/session-cost-badge-live", () => ({
  SessionCostBadgeLive: (props: { compact?: boolean; triggerClassName?: string }) => (
    <div
      data-testid="session-cost-badge"
      data-compact={props.compact || undefined}
      // Only the row copy wears the toolbar chip; the menu and rail copies
      // keep the badge's own trigger.
      data-row-chip={props.triggerClassName?.includes("h-7") ? "true" : undefined}
    />
  ),
}))

// The Router + Fusion mode chip renders nothing while Router + Fusion is off,
// which is the shipped default; its own suite covers when it shows.
let fusionChipVisible = false
const fusionChipProps: Array<{ builtinRuntime: boolean; disabled?: boolean; glyph?: boolean }> = []
jest.mock("./fusion-mode-chip", () => ({
  FusionModeChip: (props: { builtinRuntime: boolean; disabled?: boolean; glyph?: boolean }) => {
    fusionChipProps.push(props)
    return fusionChipVisible ? <div data-testid="fusion-mode-chip" /> : null
  },
}))

jest.mock("./workflow-bottom-toolbar", () => ({
  WorkflowBottomToolbar: () => <div data-testid="workflow-bottom-toolbar" />,
}))

describe("BottomToolbar — session-kind branching", () => {
  it("delegates to WorkflowBottomToolbar when session.kind === 'workflow-editor'", () => {
    const wfSession: ChatSession = {
      id: "workflow:wf_x",
      title: "Test workflow",
      kind: "workflow-editor",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    render(<BottomToolbar session={wfSession} />)
    expect(screen.getByTestId("workflow-bottom-toolbar")).toBeInTheDocument()
    // Generic-toolbar controls should not be rendered when the branch fires.
    expect(screen.queryByTestId("agent-runtime-selector")).toBeNull()
    expect(screen.queryByTestId("composition-chip")).toBeNull()
    expect(screen.queryByTestId("web-search-toggle")).toBeNull()
  })

  it("embeds the workflow toolbar inside compact composer mode", () => {
    const wfSession: ChatSession = {
      id: "workflow:wf_x",
      title: "Test workflow",
      kind: "workflow-editor",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    render(<BottomToolbar session={wfSession} variant="embedded" />)

    const embedded = screen.getByTestId("composer-toolbar-embedded")
    expect(embedded).toContainElement(screen.getByTestId("workflow-bottom-toolbar"))
    expect(screen.queryByTestId("agent-runtime-selector")).toBeNull()
  })

  it("renders the generic toolbar for a direct session", () => {
    render(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("workflow-bottom-toolbar")).toBeNull()
    // The wide row carries the whole session-shape roster inline \u2014 model,
    // permission, runtime, Agent mode, sandbox. Capability toggles live under
    // the composer's `+`, not here.
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
    expect(screen.getByTestId("sandbox-shield")).toBeInTheDocument()
    expect(screen.queryByTestId("web-search-toggle")).toBeNull()
    expect(screen.queryByTestId("enhance-button")).toBeNull()
  })

  // The "\u22ef" is a packing device for narrow composers. On a row with the space
  // to show them, hiding the active Agent mode and the sandbox state behind a
  // button that advertises neither is the collapse this layout removed.
  it("hosts the preset chip with the session-shape controls and the status at the right", () => {
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} />)
      // The system-prompt preset is a session-level choice, so it sits with the
      // mode + runtime on the far side of the hairline — not with the per-turn
      // model / thinking / permission answers.
      expect(screen.getByTestId("composer-shape-controls")).toContainElement(
        screen.getByTestId("composer-preset-chip")
      )
      expect(screen.getByTestId("composer-execution-controls")).not.toContainElement(
        screen.getByTestId("composer-preset-chip")
      )
      const cluster = screen.getByTestId("composer-status-cluster")
      expect(cluster).toContainElement(screen.getByTestId("session-cost-badge"))
      expect(cluster).toContainElement(screen.getByTestId("composer-credential-badge"))
      // On the wide row both are chips of the row, and the warning keeps its
      // words.
      expect(screen.getByTestId("session-cost-badge")).toHaveAttribute("data-row-chip", "true")
      expect(screen.getByTestId("composer-credential-badge")).not.toHaveAttribute("data-glyph")
    } finally {
      movedControlsVisible = false
    }
  })

  it("collapses nothing into an overflow menu on the wide row", () => {
    render(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
  })

  // Agent Modes compose the Claude SDK runtime's preset; an external CLI agent
  // brings its own, so the chip has nothing to say there.
  it("drops the Agent-mode chip while an external agent is selected", () => {
    agentRuntimeState.runtimeRef = { kind: "external", agentId: "a1" }
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("composition-chip")).toBeNull()
  })

  it("does not apply builtin credential warnings to an external runtime", () => {
    agentRuntimeState.runtimeRef = { kind: "external", agentId: "pi" }
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} />)
      expect(screen.queryByTestId("composer-credential-badge")).toBeNull()
    } finally {
      movedControlsVisible = false
    }
  })

  /**
   * The executor axis is not the mode axis. `use-claude-chat-controller`
   * branches to `startSquadRun` ABOVE `resolveSendOptions`, so a Squad-bound
   * turn never reaches the runtime and the binding keeps working after a switch
   * to an external agent. Hiding the chip there hid the only control that could
   * undo it, leaving the conversation permanently routed to a Squad with
   * nothing on screen saying so.
   */
  it("keeps the chip on an external agent while a Squad is bound", () => {
    agentRuntimeState.runtimeRef = { kind: "external", agentId: "a1" }
    ;(useChatExecutor as jest.Mock).mockReturnValue({
      squadId: "squad-1",
      squadName: "Review Crew",
    })
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
  })

  // The original screenshot's overlap: a long squad name rendered inside a
  // plain inline `<span>`, where `truncate` has no flex context to clip in —
  // the text painted straight over the status cluster. `inline-flex` on the
  // wrapper is what makes the inner `min-w-0 truncate` real.
  it("keeps a long squad name inside its own chip box", () => {
    ;(useChatExecutor as jest.Mock).mockReturnValue({
      squadId: "squad-1",
      squadName: "A very long review crew name that used to spill over the runtime chip",
    })
    render(<BottomToolbar session={session} />)
    const chip = screen.getByTestId("composer-executor-summary")
    expect(chip.className).toContain("inline-flex")
    expect(chip.className).toContain("max-w-[11rem]")
    const label = chip.querySelector<HTMLElement>(".truncate")
    expect(label).not.toBeNull()
    expect(label!.className).toContain("min-w-0")
  })

  // Effort qualifies the model, so its chip sits directly after the model chip
  // — and on the permanent row rather than only inside the model popover, which
  // is where it was unreachable and unreadable.
  it("carries the thinking-level chip beside the model chip", () => {
    render(<BottomToolbar session={session} />)
    const chip = screen.getByTestId("effort-chip")
    expect(chip).toBeInTheDocument()
    // Placement is the point: the chip belongs between the model it qualifies
    // and the permission chip, so the three read as one answer to "what will
    // this run as". `compareDocumentPosition` asserts that order without
    // depending on the wrapper markup.
    const permission = screen.getByTestId("permission-mode-indicator")
    expect(chip.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // A plugin dial on `chat.input.effort` writes the same two session fields the
  // host chip does. Mounting both left two thinking controls on one row, which
  // is the bug this slot exists to close: the plugin REPLACES the chip.
  it("lets a chat.input.effort plugin replace the thinking-level chip in place", () => {
    const Dial = () => <button data-testid="plugin-effort-dial">dial</button>
    registerMockExtension("chat.input.effort", Dial)
    try {
      render(<BottomToolbar session={session} />)
      const dial = screen.getByTestId("plugin-effort-dial")
      expect(screen.queryByTestId("effort-chip")).toBeNull()
      // Same seat: after the model, before the permission chip.
      const permission = screen.getByTestId("permission-mode-indicator")
      expect(
        dial.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(screen.getByTestId("composer-execution-controls")).toContainElement(dial)
      // Unregistered, the host chip comes back on the mounted row: the slot
      // subscribes to the registry, so the fallback is not a one-way swap.
      act(() => clearAllMockExtensions())
      expect(screen.queryByTestId("plugin-effort-dial")).toBeNull()
      expect(screen.getByTestId("effort-chip")).toBeInTheDocument()
    } finally {
      clearAllMockExtensions()
    }
  })

  // A crashed dial is the same as no dial: the contribution's empty surface
  // must not hold the seat while the host chip stays suppressed.
  it("restores the thinking-level chip when the effort plugin crashes", async () => {
    const BrokenDial = () => {
      throw new Error("dial crash")
    }
    registerMockExtension("chat.input.effort", BrokenDial as never)
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      render(<BottomToolbar session={session} />)
      await waitFor(() => expect(screen.getByTestId("effort-chip")).toBeInTheDocument())
      expect(screen.queryByTestId("plugin-effort-dial")).toBeNull()
    } finally {
      errorSpy.mockRestore()
      clearAllMockExtensions()
    }
  })

  // Every zone boundary carries a visible rule, and a zone with nothing in it
  // takes its rule with it (the rule is a `::before`, which `:empty` ignores).
  it("separates the zones with full-strength rules that leave with an empty zone", () => {
    const { container } = render(<BottomToolbar session={session} />)
    const divider = screen.getByTestId("composer-toolbar-divider")
    expect(divider.className).toContain("bg-border")
    expect(divider.className).not.toContain("bg-border/")
    const plugins = container.querySelector<HTMLElement>('[data-toolbar-zone="plugins"]')!
    expect(plugins.className).toContain("before:bg-border")
    expect(plugins.className).toContain("empty:hidden")
    expect(plugins).toBeEmptyDOMElement()
    expect(screen.getByTestId("composer-status-cluster").className).toContain("before:bg-border")
  })

  // The self-gate is what lets the chip live on a saturated band: a surface
  // with no depth ladder pays nothing for it, in pixels or in budget.
  it("hides the thinking-level chip on a model with no depth ladder", () => {
    mockDefaultModel = "claude-sonnet-4-5"
    render(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("effort-chip")).toBeNull()
  })

  // Regression: the row must wrap instead of pinning both ends with
  // `justify-between`, which let the left controls slide under the
  // right-aligned context indicator on a narrow (welcome) composer.
  it("lays the generic toolbar out as one row so status controls stay aligned", () => {
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex-nowrap")
    expect(root.className).not.toContain("justify-between")
  })

  // Regression: a long provider model id must ellipsize the model chip rather
  // than push Permission onto a second line. They share one `flex-nowrap` +
  // `min-w-0` row so the group shrinks as a unit.
  it("groups Tier 1 controls in a non-wrapping, shrinkable row", () => {
    const { container } = render(<BottomToolbar session={session} />)
    const nowrapRow = container.querySelector(".flex-nowrap")
    expect(nowrapRow).not.toBeNull()
    expect(nowrapRow?.className).toContain("min-w-0")
    expect(nowrapRow?.querySelector('[data-testid="permission-mode-indicator"]')).not.toBeNull()
  })

  // The overlap this row shipped with: the shadcn button base is `shrink-0`, so
  // when the group hit its `min-w-0` floor its children kept their intrinsic
  // width and rendered OUTSIDE the group — the preset chip printed through the
  // runtime chip beside it. A chip that can shrink ellipsizes its own label
  // instead, which is the whole fix.
  it("keeps every toolbar chip shrinkable so labels ellipsize instead of overlapping", () => {
    expect(TOOLBAR_CHIP).toContain("min-w-0")
    expect(TOOLBAR_CHIP).toMatch(/(^|\s)shrink(\s|$)/)
    expect(TOOLBAR_CHIP).not.toContain("shrink-0")
  })

  // ...and that rule now covers EVERY chip, including the two that used to be
  // pinned. `shrink-0` is what let the group paint over the status cluster the
  // moment it hit its floor — and shaving "Auto" to "A…" is no longer the
  // fallback either: below the glyphs fold tier these chips switch to
  // icon-only forms, so no label ever has to die mid-word.
  it("lets every chip give up width — the fold ladder, not `shrink-0`, protects the labels", () => {
    render(<BottomToolbar session={session} />)
    // Token compare, not substring: the shadcn button base carries
    // `[&_svg]:shrink-0` to pin the ICON, which is fine — the chip itself must
    // be the thing that yields.
    const classes = (el: HTMLElement) => el.className.split(/\s+/)
    for (const id of ["permission-mode-indicator", "effort-chip"] as const) {
      const el = screen.getByTestId(id)
      expect(classes(el)).toContain("shrink")
      expect(classes(el)).not.toContain("shrink-0")
    }
  })

  // The wide branch is the one the user stares at all day, so it carries the
  // budget. Ratchet, not a target — see lib/ui/chrome-budget.ts.
  it("stays within the composer-toolbar chrome control budget", () => {
    const { container } = render(<BottomToolbar session={session} />)
    expect(countControls(container)).toBeLessThanOrEqual(CHROME_BUDGET.composerToolbar)
  })
})

describe("BottomToolbar — Router + Fusion mode chip", () => {
  afterEach(() => {
    fusionChipVisible = false
    fusionChipProps.length = 0
  })

  it("sits with the per-turn answers and is told the runtime and the turn state", () => {
    fusionChipVisible = true
    chatStoreState.status = "streaming"
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("composer-execution-controls")).toContainElement(
      screen.getByTestId("fusion-mode-chip")
    )
    expect(fusionChipProps.at(-1)).toMatchObject({ builtinRuntime: true, disabled: true })
  })

  it("tells the chip when the conversation runs on an external agent", () => {
    agentRuntimeState.runtimeRef = { kind: "external", agentId: "codex" } as never
    render(<BottomToolbar session={session} />)
    expect(fusionChipProps.at(-1)).toMatchObject({ builtinRuntime: false, disabled: false })
  })

  it("is not offered on a Squad-bound conversation, which runs on each member's own model", () => {
    fusionChipVisible = true
    ;(useChatExecutor as jest.Mock).mockReturnValue({ squadId: "sq1", squadName: "Team" })
    render(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("fusion-mode-chip")).toBeNull()
  })
})

describe("BottomToolbar — narrow-width More menu", () => {
  it("embeds primary controls and keeps advanced controls in overflow for compact composer mode", () => {
    // The in-box layouts ride the same fold ladder as the detached row now —
    // pin the narrow end so the tail actually has something to fold.
    mockToolbarWidth = 300
    render(<BottomToolbar session={session} variant="embedded" />)

    expect(screen.getByTestId("composer-toolbar-embedded")).toBeInTheDocument()
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
  })

  // The width that used to render "Standard" + a bare shield as a floating
  // card inside the input box. At this width nothing needs to fold, so the
  // roster sits on the row itself and no "⋯" exists to open.
  it("spells the roster out inline at tier 0 instead of parking it in a floating card", () => {
    mockToolbarWidth = 900
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} variant="embedded" />)
      expect(screen.getByTestId("composer-toolbar-embedded")).toHaveAttribute(
        "data-toolbar-tier",
        "0"
      )
      expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
      expect(screen.getByTestId("composition-chip")).toHaveAttribute("data-layout", "split")
      expect(screen.getByTestId("composer-preset-chip")).toBeInTheDocument()
      expect(screen.getByTestId("composer-status-cluster")).toContainElement(
        screen.getByTestId("sandbox-shield")
      )
    } finally {
      movedControlsVisible = false
    }
  })

  // Folded controls render as captioned rows — the caption is what keeps a
  // folded chip from reading as a stray floating element inside the box.
  it("captions each folded control inside the embedded disclosure", () => {
    mockToolbarWidth = 600
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} variant="embedded" />)
      // Tier 1 still holds the mode on the row; preset + sandbox fold.
      expect(screen.getByTestId("composition-chip")).toHaveAttribute("data-layout", "split")
      fireEvent.click(screen.getByTestId("composer-toolbar-more"))
      expect(screen.getByText("moreMenu.preset")).toBeInTheDocument()
      expect(screen.getByText("moreMenu.sandbox")).toBeInTheDocument()
      expect(screen.getByTestId("composer-preset-chip")).toBeInTheDocument()
      expect(screen.getByTestId("sandbox-shield")).toBeInTheDocument()
    } finally {
      movedControlsVisible = false
    }
  })

  // Radix fires a tooltip on FOCUS — instantly, ignoring delayDuration — so
  // the disclosure must not land mount-focus on a folded chip: opening "⋯"
  // would pop that chip's tooltip before the pointer even moved. Focus goes
  // to the popover shell instead; Tab still walks the rows in order.
  it("focuses the disclosure shell on open, not a folded chip", () => {
    mockToolbarWidth = 300
    render(<BottomToolbar session={session} variant="embedded" />)
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    const shell = document.querySelector('[data-slot="popover-content"]')
    expect(shell).not.toBeNull()
    expect(document.activeElement).toBe(shell)
  })

  it("folds the mode chip into the embedded disclosure, captioned, at tier 2", () => {
    mockToolbarWidth = 450
    render(<BottomToolbar session={session} variant="embedded" />)
    expect(screen.queryByTestId("composition-chip")).toBeNull()
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByText("moreMenu.mode")).toBeInTheDocument()
    expect(screen.getByTestId("composition-chip")).toHaveAttribute("data-layout", "combined")
  })

  // Every width shows the SAME roster — the branches differ only in how the row
  // is packed. That is what keeps each control mounted in exactly one place:
  // wide lays them out, narrower folds the tail into "⋯" in stages.
  it("shows the same controls at every width, differing only in packing", () => {
    mockToolbarWidth = 600
    const wide = render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
    // Tier 1 already folds the ambient tail — preset, sandbox, plugin slots sit
    // behind "⋯" — while every per-turn answer stays inline and labelled.
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("sandbox-shield")).toBeInTheDocument()
    wide.unmount()

    mockToolbarWidth = 300
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("composition-chip")).toBeNull()
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
  })

  // The threshold moved 384 → 520 with the roster: below that the one row can
  // only be held by shaving every label to a stub. Above it, one row.
  it("keeps a medium-width toolbar on one row instead of splitting status chrome early", () => {
    mockToolbarWidth = 560
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex-nowrap")
    expect(root.className).not.toContain("flex-col")
  })

  // Regression: the compact toolbar is ONE row. It used to wrap into two, with
  // the read-only status glyphs pushed onto a second line whose left half was
  // always empty — 28px of chrome directly under the composer, on the surface
  // (the phone welcome screen) with the least room for it. The width is bought
  // by folding the tail of the roster behind `⋯`, not by wrapping.
  it("keeps the compact toolbar on one row with the status controls clustered at the end", () => {
    mockToolbarWidth = 300
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).not.toContain("flex-col")
    expect(root.className).toContain("flex-nowrap")
    // Context usage and More belong to one secondary cluster pinned right, not
    // to opposite edges of an otherwise empty row.
    const more = screen.getByTestId("composer-toolbar-more")
    const cluster = more.parentElement as HTMLElement
    expect(cluster).toBe(screen.getByTestId("composer-status-cluster"))
    expect(cluster.className).toContain("ms-auto")
    expect(cluster.className).toContain("shrink-0")
  })

  // The left half has to be the side that gives up width: every control on the
  // right is a glyph with no label to shave.
  it("lets the compact row's config side shrink instead of the status cluster", () => {
    mockToolbarWidth = 300
    const { container } = render(<BottomToolbar session={session} />)
    expect((container.firstChild as HTMLElement).className).toContain("min-w-0")
    expect(screen.getByTestId("composer-status-cluster").className).toContain("shrink-0")
  })
})

// ── The fold ladder ────────────────────────────────────────────────────────
//
// `resolveToolbarFoldTier` maps the measured width to a rung; these tests pin
// what each rung means on the row. Same roster at every tier — what changes is
// how each control is spelled: labelled, icon-only, or inside the "⋯"
// disclosure in its full form. The resolver's own boundary table lives in
// `lib/chat/composer-skin.test.ts`.
describe("BottomToolbar — the fold ladder", () => {
  it("keeps the full labelled roster inline at tier 0", () => {
    mockToolbarWidth = 900
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("composer-footer")).toHaveAttribute("data-toolbar-tier", "0")
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
    // The sandbox state is an ambient read-out: inline at this width, not
    // behind a menu the user would have to open to learn it.
    expect(screen.getByTestId("composer-status-cluster")).toContainElement(
      screen.getByTestId("sandbox-shield")
    )
  })

  it("folds preset, sandbox and the plugin affordances at tier 1", () => {
    mockToolbarWidth = 600
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} />)
      expect(screen.getByTestId("composer-footer")).toHaveAttribute("data-toolbar-tier", "1")
      // The per-turn answers and the session shape stay labelled and inline;
      // only the ambient tail folds.
      expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
      expect(screen.getByTestId("agent-runtime-selector")).not.toHaveAttribute("data-dense")
      expect(screen.queryByTestId("composer-preset-chip")).toBeNull()
      fireEvent.click(screen.getByTestId("composer-toolbar-more"))
      expect(screen.getByTestId("composer-preset-chip")).toBeInTheDocument()
      expect(screen.getByTestId("sandbox-shield")).toBeInTheDocument()
      // ...and the session-cost badge switched to its short `$x.xx` form.
      expect(screen.getByTestId("session-cost-badge")).toHaveAttribute("data-compact", "true")
    } finally {
      movedControlsVisible = false
    }
  })

  it("folds the credential warning to its key glyph at tier 2", () => {
    mockToolbarWidth = 450
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} />)
      // The "No API key" warning folds to its key glyph with the per-turn
      // chips — its words were what squeezed the model chip on a phone.
      expect(screen.getByTestId("composer-credential-badge")).toHaveAttribute("data-glyph", "true")
    } finally {
      movedControlsVisible = false
    }
  })

  it("glyphs the per-turn chips and folds Agent mode at tier 2", () => {
    mockToolbarWidth = 450
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("composer-footer")).toHaveAttribute("data-toolbar-tier", "2")
    // The runtime chip drops its name — a dense glyph joins the status
    // cluster — and the mode chip folds into "⋯" in its combined form.
    expect(screen.getByTestId("agent-runtime-selector")).toHaveAttribute("data-dense", "true")
    expect(screen.getByTestId("effort-chip")).toHaveAttribute("data-glyph", "true")
    expect(screen.getByTestId("permission-mode-indicator")).toHaveAttribute("data-glyph", "true")
    expect(fusionChipProps.at(-1)).toMatchObject({ glyph: true })
    expect(screen.queryByTestId("composition-chip")).toBeNull()
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("composition-chip")).toHaveAttribute("data-layout", "combined")
  })

  it("folds fusion and the session-cost badge at tier 3, fully labelled inside", () => {
    mockToolbarWidth = 340
    fusionChipVisible = true
    try {
      render(<BottomToolbar session={session} />)
      expect(screen.getByTestId("composer-footer")).toHaveAttribute("data-toolbar-tier", "3")
      expect(screen.queryByTestId("fusion-mode-chip")).toBeNull()
      expect(screen.queryByTestId("session-cost-badge")).toBeNull()
      fireEvent.click(screen.getByTestId("composer-toolbar-more"))
      // Both render their FULL form inside the disclosure — a glyph in a menu
      // teaches nothing.
      expect(screen.getByTestId("fusion-mode-chip")).toBeInTheDocument()
      expect(fusionChipProps.at(-1)).toMatchObject({ glyph: false })
      expect(screen.getByTestId("session-cost-badge")).not.toHaveAttribute("data-compact")
      expect(screen.getByTestId("session-cost-badge")).not.toHaveAttribute("data-row-chip")
    } finally {
      fusionChipVisible = false
    }
  })

  // The fold must not smuggle a control the send path would ignore onto the
  // row through the menu: a Squad runs each member's own model, so fusion is
  // hidden inline AND in the disclosure.
  it("never offers fusion inside the disclosure on a Squad-bound conversation", () => {
    mockToolbarWidth = 340
    fusionChipVisible = true
    ;(useChatExecutor as jest.Mock).mockReturnValue({ squadId: "sq1", squadName: "Team" })
    try {
      render(<BottomToolbar session={session} />)
      fireEvent.click(screen.getByTestId("composer-toolbar-more"))
      expect(screen.queryByTestId("fusion-mode-chip")).toBeNull()
    } finally {
      fusionChipVisible = false
    }
  })

  it("keeps the whole roster reachable through the disclosure at tier 4", () => {
    mockToolbarWidth = 280
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("composer-footer")).toHaveAttribute("data-toolbar-tier", "4")
    // The ring-only assertion on the indicator itself lives in its own suite;
    // here the contract is that the roster still resolves through the
    // disclosure — nothing is dropped.
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
    expect(screen.getByTestId("session-cost-badge")).toBeInTheDocument()
  })
})

describe("BottomToolbar — agent-mode wiring", () => {
  /** The wide row mounts the mode selector directly — no menu to open first. */
  function renderWide(node: React.ReactElement) {
    return render(node)
  }

  // The chip is scoped to the session it sits under. Its predecessor took no
  // session at all and wrote the app-wide default, which is why changing the
  // mode here stopped affecting a conversation once the settings sheet had
  // recorded a per-session choice.
  it("scopes the mode control to the current session", () => {
    renderWide(<BottomToolbar session={session} />)
    expect(lastSelectorProps.sessionId).toBe("s1")
  })

  it("passes no session id before there is a session, so the chip edits the default", () => {
    renderWide(<BottomToolbar session={null} />)
    expect(lastSelectorProps.sessionId).toBeUndefined()
  })

  it("disables the mode control while a turn is streaming", () => {
    chatStoreState = { ...chatStoreState, status: "streaming" }
    renderWide(<BottomToolbar session={session} />)
    expect(lastSelectorProps.disabled).toBe(true)
  })

  it("cycles the permission mode through the chat store", () => {
    renderWide(<BottomToolbar session={session} />)
    const onCycle = lastSelectorProps.onCycle as (next: string) => void
    onCycle("acceptEdits")
    // The trailing session id is what keeps an unfocused split pane's Shift+Tab
    // off the pane beside it; `undefined` here is "no provider in this test",
    // which the store reads as "the focused conversation".
    expect(chatStoreState.setPermissionMode).toHaveBeenCalledWith("acceptEdits", undefined)
  })

  it("passes disabled=true to child controls when streaming", () => {
    chatStoreState.status = "streaming"
    renderWide(<BottomToolbar session={session} />)
    expect(lastSelectorProps.disabled).toBe(true)
  })

  it("passes disabled=false to child controls when idle", () => {
    renderWide(<BottomToolbar session={session} />)
    expect(lastSelectorProps.disabled).toBe(false)
  })

  // The runtime chip owns the external-agent record now (one dropdown, one
  // choice), so the toolbar no longer brokers a second selector's callback.
  it("mounts no separate external-agent selector", () => {
    agentRuntimeState.runtimeRef = { kind: "external", agentId: "a1" }
    renderWide(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("external-agent-selector")).toBeNull()
    expect(lastSelectorProps.onAgentChange).toBeUndefined()
  })
})

// ── Reachability, not visibility ───────────────────────────────────────────
//
// The contract a composer skin signs: it may move a control inline, onto a
// rail, or behind the "⋯" disclosure — it may not drop one. `focus` folds the
// most and is the interesting case; if this ever passes because a control
// stopped mounting anywhere, the whole skin system is lying about what it does.
describe("BottomToolbar — every layout keeps the whole roster reachable", () => {
  const ROSTER = [
    "permission-mode-indicator",
    "agent-runtime-selector",
    "composition-chip",
    "composer-preset-chip",
  ] as const

  const LAYOUTS = ["detached", "embedded", "rail", "expanded", "folded"] as const

  beforeEach(() => {
    mockToolbarWidth = 900
    movedControlsVisible = true
  })

  it.each(LAYOUTS)("%s reaches every control, inline or folded", (layout) => {
    const view = render(<BottomToolbar session={session} variant={layout} />)
    // Open the disclosure if this layout has one — that is a legitimate home.
    const more = screen.queryByTestId("composer-toolbar-more")
    if (more) fireEvent.click(more)
    for (const id of ROSTER) {
      expect(screen.queryByTestId(id)).not.toBeNull()
    }
    view.unmount()
  })

  it("folds nearly everything under focus, keeping only the per-turn model inline", () => {
    render(<BottomToolbar session={session} variant="folded" />)
    // Before opening the disclosure, the row is quiet.
    expect(screen.queryByTestId("agent-runtime-selector")).toBeNull()
    expect(screen.queryByTestId("composition-chip")).toBeNull()
    // And the disclosure is what makes them reachable.
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
  })

  it("gives the ambient rail the full-verbosity cost and credential", () => {
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} variant="expanded" />)
      const rail = screen.getByTestId("composer-ambient-rail")
      // The rail owns the ambient numbers at full verbosity, whatever the tier.
      const credential = within(rail).getByTestId("composer-credential-badge")
      expect(credential).not.toHaveAttribute("data-glyph")
      expect(within(rail).getByTestId("session-cost-badge")).not.toHaveAttribute("data-row-chip")
    } finally {
      movedControlsVisible = false
    }
  })

  it("lays the roster out inline under full, with an ambient rail beside it", () => {
    render(<BottomToolbar session={session} variant="expanded" />)
    expect(screen.getByTestId("composer-ambient-rail")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
  })

  it("gives up the inline roster in a pane too narrow to hold it", () => {
    // Skin proposes, width disposes: `expanded` cannot fit here, so it packs.
    // Nothing is lost — the tail is under "⋯", which the roster test above
    // already proves for this layout.
    mockToolbarWidth = 300
    render(<BottomToolbar session={session} variant="expanded" />)
    expect(screen.queryByTestId("composer-ambient-rail")).toBeNull()
    expect(screen.getByTestId("composer-toolbar-embedded")).toBeInTheDocument()
  })

  it("gives rail the same roster as embedded, only quieter", () => {
    const railView = render(<BottomToolbar session={session} variant="rail" />)
    const rail = screen.getByTestId("composer-toolbar-embedded")
    expect(rail).toHaveAttribute("data-toolbar-layout", "rail")
    expect(rail.className).toContain("font-mono")
    railView.unmount()

    render(<BottomToolbar session={session} variant="embedded" />)
    const embedded = screen.getByTestId("composer-toolbar-embedded")
    expect(embedded).toHaveAttribute("data-toolbar-layout", "embedded")
    expect(embedded.className).not.toContain("font-mono")
  })

  it("treats the legacy 'default' variant as detached", () => {
    render(<BottomToolbar session={session} variant="default" />)
    expect(screen.getByTestId("composer-footer")).toBeInTheDocument()
    expect(screen.queryByTestId("composer-toolbar-embedded")).toBeNull()
  })
})

it("mounts session status in the ambient composer cluster", () => {
  render(
    <WebStatusProvider enabled>
      <BottomToolbar session={session} variant="detached" />
    </WebStatusProvider>
  )
  expect(screen.getByTestId("composer-status-cluster")).toContainElement(
    screen.getByTestId("segment-connectivity")
  )
  expect(screen.queryByTestId("segment-runStatus")).toBeNull()
})
