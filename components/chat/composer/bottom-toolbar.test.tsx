/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { BottomToolbar } from "./bottom-toolbar"
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
  PermissionModeIndicator: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="permission-mode-indicator" />
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
  it("hosts the preset chip with model + permission and the session status at the right", () => {
    movedControlsVisible = true
    try {
      render(<BottomToolbar session={session} />)
      // Preset sits inside the execution group (it self-hides, so no divider of its own).
      expect(screen.getByTestId("composer-execution-controls")).toContainElement(
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

  it("keeps a medium-width toolbar on one row instead of splitting status chrome early", () => {
    mockToolbarWidth = 420
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
