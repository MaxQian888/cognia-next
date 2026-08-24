/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { BottomToolbar, TOOLBAR_CHIP } from "./bottom-toolbar"
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
jest.mock("@/components/agent/composition/composition-chip", () => ({
  CompositionChip: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="composition-chip" />
  },
}))
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="agent-runtime-selector" />
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
    return <div data-testid="permission-mode-indicator" className={String(props.className ?? "")} />
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

// Agent store state — mutated by tests that need different runtime/mode.
let agentRuntimeState = {
  runtime: "claude-sdk" as string,
  modeId: "general" as string,
  setModeId: jest.fn(),
  externalAgentId: null as string | null,
  setExternalAgentId: jest.fn(),
}

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: <T,>(selector: (s: typeof agentRuntimeState) => T) =>
    selector(agentRuntimeState),
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
  pushSpy.mockClear()
  chatStoreState = {
    messages: [],
    status: "idle",
    setPermissionMode: jest.fn(),
  }
  agentRuntimeState = {
    runtime: "claude-sdk",
    modeId: "general",
    setModeId: jest.fn(),
    externalAgentId: null,
    setExternalAgentId: jest.fn(),
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
  ComposerCredentialBadge: () =>
    movedControlsVisible ? <div data-testid="composer-credential-badge" /> : null,
}))
jest.mock("@/components/chat/session-cost-badge-live", () => ({
  SessionCostBadgeLive: () => <div data-testid="session-cost-badge" />,
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
    agentRuntimeState.runtime = "external"
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("composition-chip")).toBeNull()
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

  // ...except the two whose labels are already short. Shaving "Auto" to "A…"
  // buys 30px and costs the word; the model id next to them is the string worth
  // ellipsizing, and below the compact threshold the row re-packs anyway.
  it("pins the short-labelled chips against shrinking", () => {
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("permission-mode-indicator").className).toContain("shrink-0")
    expect(screen.getByTestId("effort-chip").className).toContain("shrink-0")
  })

  // The wide branch is the one the user stares at all day, so it carries the
  // budget. Ratchet, not a target — see lib/ui/chrome-budget.ts.
  it("stays within the composer-toolbar chrome control budget", () => {
    const { container } = render(<BottomToolbar session={session} />)
    expect(countControls(container)).toBeLessThanOrEqual(CHROME_BUDGET.composerToolbar)
  })
})

describe("BottomToolbar — narrow-width More menu", () => {
  it("embeds primary controls and keeps advanced controls in overflow for compact composer mode", () => {
    render(<BottomToolbar session={session} variant="embedded" />)

    expect(screen.getByTestId("composer-toolbar-embedded")).toBeInTheDocument()
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
  })

  // Every width shows the SAME roster — the branches differ only in how the row
  // is packed. That is what keeps each control mounted in exactly one place:
  // wide lays them out, narrow folds the tail into "⋯".
  it("shows the same controls wide as compact, differing only in packing", () => {
    mockToolbarWidth = 600
    const wide = render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.getByTestId("composition-chip")).toBeInTheDocument()
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
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

  // Regression: the compact toolbar must cap at TWO rows (Tier 1, then the
  // overflow menu + context indicator sharing the second row) instead of
  // letting `⋯` and the usage `%` each wrap onto their own line (three rows).
  it("caps the compact toolbar at two rows and groups secondary status controls at the end", () => {
    mockToolbarWidth = 300
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex-col")
    // Context usage and More belong to one secondary cluster, not opposite
    // edges of an otherwise empty row.
    const more = screen.getByTestId("composer-toolbar-more")
    expect((more.parentElement as HTMLElement).className).toContain("justify-end")
    expect((more.parentElement as HTMLElement).className).not.toContain("justify-between")
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
    expect(chatStoreState.setPermissionMode).toHaveBeenCalledWith("acceptEdits")
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
    agentRuntimeState.runtime = "external"
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

  it("lays the roster out inline under full, with an ambient rail beside it", () => {
    render(<BottomToolbar session={session} variant="expanded" />)
    expect(screen.getByTestId("composer-ambient-rail")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
  })

  it("keeps the full roster inline even in a narrow pane, once the skin asked for it", () => {
    // `resolveToolbarLayout` is what protects a genuinely narrow pane; if the
    // caller still says `expanded`, re-deciding here on raw width would undo it.
    mockToolbarWidth = 300
    render(<BottomToolbar session={session} variant="expanded" />)
    expect(screen.getByTestId("composer-ambient-rail")).toBeInTheDocument()
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
