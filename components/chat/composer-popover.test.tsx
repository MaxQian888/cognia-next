/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"
import { ComposerPopover, type ComposerPopoverHandle } from "./composer-popover"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ComposerTrigger, MentionableWorkflowElement } from "./composer-trigger"
import { useRemoteDocSearch } from "@/hooks/chat/use-remote-doc-search"
import type { RemoteDocSearchState } from "@/hooks/chat/use-remote-doc-search"

const useRemoteDocSearchMock = useRemoteDocSearch as jest.MockedFunction<typeof useRemoteDocSearch>

function docSearchState(overrides: Partial<RemoteDocSearchState> = {}): RemoteDocSearchState {
  return {
    provider: null,
    hostSupported: false,
    accounts: null,
    accountId: null,
    setAccountId: jest.fn(),
    items: [],
    loading: false,
    error: null,
    linkOnly: false,
    ...overrides,
  }
}

beforeEach(() => {
  useRemoteDocSearchMock.mockReturnValue(docSearchState())
})

// Stable `t` per the real next-intl contract (its `t` identity is memoized).
// A fresh function each render would churn effect deps (the file-search effect
// lists `t`) and loop — that's a mock artifact, not component behaviour.
jest.mock("next-intl", () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key
  return { useTranslations: () => t }
})

jest.mock("@/hooks/chat/use-remote-doc-search", () => ({
  useRemoteDocSearch: jest.fn(),
}))

// Descriptions are blank (except /review) so the secondary description match
// can't pull extra commands into a short-query result — keeps name-ranking
// assertions deterministic. The "diff" test exercises the description path.
const commands = [
  { name: "clear", description: "", scope: "builtin", category: "chat" },
  { name: "compact", description: "", scope: "builtin" },
  { name: "cost", description: "", scope: "builtin" },
  { name: "model", description: "", scope: "builtin" },
  {
    name: "review",
    description: "Inspect the diff",
    scope: "builtin",
    category: "template",
    argumentHint: "<focus area?>",
  },
  {
    name: "permission-mode",
    description: "Set the permission mode",
    scope: "builtin",
    category: "system",
    argumentHint: "<default | acceptEdits | plan | bypassPermissions>",
    argumentOptions: ["default", "acceptEdits", "plan", "bypassPermissions"],
  },
  {
    name: "enum-only",
    description: "Uses a structured enum",
    scope: "builtin",
    params: [
      {
        name: "mode",
        label: "Mode",
        type: "enum",
        options: ["alpha", "beta"],
      },
    ],
  },
] as SlashCommand[]

function slashTrigger(query: string): ComposerTrigger {
  return { kind: "slash", tokenStart: 0, tokenEnd: query.length + 1, query }
}

function slashArgumentTrigger(command: string, query: string): ComposerTrigger {
  const argumentStart = command.length + 2
  return {
    kind: "slash",
    tokenStart: 0,
    tokenEnd: command.length + 1,
    query: command,
    argumentStart,
    argumentEnd: argumentStart + query.length,
    argumentQuery: query,
  }
}

function setup(trigger: ComposerTrigger | null, onPick = jest.fn(), onDismiss = jest.fn()) {
  const anchor = document.createElement("div")
  document.body.appendChild(anchor)
  const ref = createRef<ComposerPopoverHandle>()
  const view = render(
    <ComposerPopover
      ref={ref}
      trigger={trigger}
      cwd={null}
      slashCommands={commands}
      anchor={anchor}
      onPick={onPick}
      onDismiss={onDismiss}
    />
  )
  return { ref, onPick, onDismiss, unmount: view.unmount }
}

function rowTexts(): string[] {
  return screen.getAllByRole("listitem").map((li) => li.textContent ?? "")
}

describe("ComposerPopover — slash fuzzy ranking", () => {
  it("renders nothing when there is no trigger", () => {
    setup(null)
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })

  it("fuzzy-filters and ranks the best slash match first", () => {
    setup(slashTrigger("co"))
    const texts = rowTexts()
    // Only "cost" and "compact" are subsequences of "co"; shorter prefix wins.
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain("/cost")
    expect(texts[1]).toContain("/compact")
    expect(texts.some((t) => t.includes("/clear"))).toBe(false)
  })

  it("matches against the description as a secondary source", () => {
    setup(slashTrigger("diff"))
    const texts = rowTexts()
    // No command name contains "diff"; only /review's description does.
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("/review")
  })

  it("shows the no-match empty message when nothing matches", () => {
    setup(slashTrigger("zzzzz"))
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.getByText(/noCommandMatches/)).toBeInTheDocument()
  })

  it("matches the composer width without an arbitrary desktop cap", () => {
    setup(slashTrigger(""))
    const content = screen.getByRole("dialog")
    expect(content.className).toContain("var(--radix-popper-anchor-width)")
    expect(content.className).not.toContain("max-w-[480px]")
  })

  it("offers a dedicated search that matches command descriptions", async () => {
    setup(slashTrigger(""))

    const search = screen.getByRole("searchbox", { name: "searchAria" })
    fireEvent.change(search, { target: { value: "diff" } })

    await waitFor(() => expect(rowTexts()).toHaveLength(1))
    expect(rowTexts()[0]).toContain("/review")
  })

  it("supports navigation, selection, and dismissal from the search field", async () => {
    const onPick = jest.fn()
    const onDismiss = jest.fn()
    setup(slashTrigger(""), onPick, onDismiss)

    const search = screen.getByRole("searchbox", { name: "searchAria" })
    fireEvent.change(search, { target: { value: "co" } })
    await waitFor(() => expect(rowTexts()).toHaveLength(2))

    fireEvent.keyDown(search, { key: "ArrowDown" })
    fireEvent.keyDown(search, { key: "Enter" })
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slash",
        command: expect.objectContaining({ name: "compact" }),
      })
    )

    fireEvent.keyDown(search, { key: "Escape" })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("keeps entrance motion decorative under reduced-motion preferences", () => {
    setup(slashTrigger(""))
    expect(screen.getByRole("dialog").className).toContain("motion-reduce:animate-none")
  })

  it("explains how to compose multiple commands", () => {
    setup(slashTrigger(""))
    expect(screen.getByText("multiCommandHint")).toBeInTheDocument()
  })

  it("uses category-specific command icons and structured argument tokens", () => {
    setup(slashTrigger("review"))
    expect(document.querySelector('[data-command-icon="template"]')).not.toBeNull()
    expect(screen.getByText("focus area?")).toHaveAttribute("data-slot", "command-argument")
  })

  it("suggests and keyboard-selects matching options for the first command argument", async () => {
    const onPick = jest.fn()
    const { ref } = setup(slashArgumentTrigger("permission-mode", "p"), onPick)

    await waitFor(() => expect(rowTexts()).toEqual(["plan", "bypassPermissions", "acceptEdits"]))
    act(() => ref.current?.confirm())
    expect(onPick).toHaveBeenCalledWith({
      kind: "slashArgument",
      command: expect.objectContaining({ name: "permission-mode" }),
      value: "plan",
      replaceStart: 17,
      replaceEnd: 18,
    })
  })

  it("falls back to enum param options and shows a useful no-match state", () => {
    const { unmount } = setup(slashArgumentTrigger("enum-only", "b"))
    expect(rowTexts()).toEqual(["beta"])
    unmount()

    setup(slashArgumentTrigger("permission-mode", "zzz"))
    expect(
      screen.getByText((content) => content.startsWith("noArgumentMatches"))
    ).toBeInTheDocument()
  })
})

const wfElements: MentionableWorkflowElement[] = [
  {
    type: "node",
    id: "n_a",
    label: "Draft issue",
    kind: "ai.prompt",
    sublabel: "ai.prompt",
    searchText: "n_a draft issue ai.prompt",
  },
  {
    type: "node",
    id: "n_b",
    label: "Split path",
    kind: "flow.branch",
    sublabel: "flow.branch",
    searchText: "n_b split path flow.branch",
  },
  {
    type: "edge",
    id: "e_1",
    label: "A → B",
    kind: "default",
    sublabel: "A → B",
    searchText: "e_1 a → b default",
  },
]

function wfTrigger(kind: "wfNode" | "wfEdge", query: string): ComposerTrigger {
  return { kind, tokenStart: 0, tokenEnd: query.length + 1, query }
}

function setupWf(
  trigger: ComposerTrigger,
  handlers: { onPick?: jest.Mock; onHighlightElement?: jest.Mock } = {}
) {
  const onPick = handlers.onPick ?? jest.fn()
  const onHighlightElement = handlers.onHighlightElement ?? jest.fn()
  const anchor = document.createElement("div")
  document.body.appendChild(anchor)
  const ref = createRef<ComposerPopoverHandle>()
  render(
    <ComposerPopover
      ref={ref}
      trigger={trigger}
      cwd={null}
      slashCommands={commands}
      anchor={anchor}
      workflowElements={wfElements}
      onHighlightElement={onHighlightElement}
      onPick={onPick}
      onDismiss={jest.fn()}
    />
  )
  return { ref, onPick, onHighlightElement }
}

describe("ComposerPopover — workflow node/edge picker", () => {
  it("lists only nodes for a wfNode trigger", () => {
    setupWf(wfTrigger("wfNode", ""))
    const texts = rowTexts()
    expect(texts.some((t) => t.includes("Draft issue"))).toBe(true)
    expect(texts.some((t) => t.includes("Split path"))).toBe(true)
    expect(texts.some((t) => t.includes("A → B"))).toBe(false)
  })

  it("lists only edges for a wfEdge trigger", () => {
    setupWf(wfTrigger("wfEdge", ""))
    const texts = rowTexts()
    expect(texts.some((t) => t.includes("A → B"))).toBe(true)
    expect(texts.some((t) => t.includes("Draft issue"))).toBe(false)
  })

  it("fuzzy-filters nodes by query", () => {
    setupWf(wfTrigger("wfNode", "split"))
    const texts = rowTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("Split path")
  })

  it("shows the empty message when no nodes match", () => {
    setupWf(wfTrigger("wfNode", "zzzzz"))
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.getByText(/noWorkflowNodeMatches/)).toBeInTheDocument()
  })

  it("reports the highlighted element via onHighlightElement", () => {
    const { onHighlightElement } = setupWf(wfTrigger("wfNode", ""))
    // Mount highlights row 0 (the first node).
    expect(onHighlightElement).toHaveBeenCalledWith(wfElements[0])
  })

  it("picks a wfElement item on confirm", () => {
    const { ref, onPick } = setupWf(wfTrigger("wfNode", ""))
    act(() => {
      ref.current?.confirm()
    })
    expect(onPick).toHaveBeenCalledWith({ kind: "wfElement", element: wfElements[0] })
  })
})

describe("ComposerPopover — keyboard navigation handle", () => {
  it("confirm() picks the highlighted (first) item", () => {
    const { ref, onPick } = setup(slashTrigger("co"))
    let picked = false
    act(() => {
      picked = ref.current!.confirm()
    })
    expect(picked).toBe(true)
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slash",
        command: expect.objectContaining({ name: "cost" }),
      })
    )
  })

  it("navigate() moves the highlight before confirming", () => {
    const { ref, onPick } = setup(slashTrigger("co"))
    act(() => {
      ref.current!.navigate(1)
    })
    act(() => {
      ref.current!.confirm()
    })
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slash",
        command: expect.objectContaining({ name: "compact" }),
      })
    )
  })

  it("navigate() wraps around the list", () => {
    const { ref, onPick } = setup(slashTrigger("co"))
    act(() => {
      ref.current!.navigate(-1)
    })
    act(() => {
      ref.current!.confirm()
    })
    // Wrapping up from index 0 lands on the last item ("compact").
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slash",
        command: expect.objectContaining({ name: "compact" }),
      })
    )
  })

  it("confirm() returns false when the list is empty", () => {
    const { ref, onPick } = setup(slashTrigger("zzzzz"))
    let picked = true
    act(() => {
      picked = ref.current!.confirm()
    })
    expect(picked).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe("ComposerPopover — combined @ panel (subagents + files)", () => {
  const chatAgents = [
    {
      id: "workflow-designer",
      name: "Workflow Designer",
      description: "Designs flows",
      handle: "workflow-designer",
    },
    {
      id: "template:my-reviewer",
      name: "My Reviewer",
      description: "Reviews code",
      model: "opus",
      handle: "my-reviewer",
    },
  ]

  function fileTrigger(query: string): ComposerTrigger {
    return { kind: "file", tokenStart: 0, tokenEnd: query.length + 1, query }
  }

  function setupCombined(query: string, onPick = jest.fn()) {
    const anchor = document.createElement("div")
    document.body.appendChild(anchor)
    const ref = createRef<ComposerPopoverHandle>()
    render(
      <ComposerPopover
        ref={ref}
        trigger={fileTrigger(query)}
        cwd={null}
        slashCommands={commands}
        anchor={anchor}
        chatAgents={chatAgents}
        onPick={onPick}
        onDismiss={jest.fn()}
      />
    )
    return { ref, onPick }
  }

  it("lists matching subagents under an Agents section header", () => {
    setupCombined("")
    // Both agents render as @handle rows.
    expect(screen.getByTestId("subagent-mention-row-workflow-designer")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-mention-row-template:my-reviewer")).toBeInTheDocument()
    // Agents section header is rendered (mocked t returns the key). The Files
    // header only appears once file results exist (needs a live workspace).
    expect(screen.getByText("agentsSection")).toBeInTheDocument()
  })

  it("fuzzy-filters the agent section by the @handle query", () => {
    setupCombined("rev")
    expect(screen.queryByTestId("subagent-mention-row-workflow-designer")).not.toBeInTheDocument()
    expect(screen.getByTestId("subagent-mention-row-template:my-reviewer")).toBeInTheDocument()
  })

  it("confirm() picks the highlighted subagent (flat keyboard nav across the panel)", () => {
    const { ref, onPick } = setupCombined("")
    act(() => {
      ref.current!.confirm()
    })
    expect(onPick).toHaveBeenCalledWith({
      kind: "subagent",
      target: expect.objectContaining({ id: "workflow-designer", handle: "workflow-designer" }),
    })
  })

  it("does not show section headers when there are no subagents", () => {
    const anchor = document.createElement("div")
    document.body.appendChild(anchor)
    render(
      <ComposerPopover
        ref={createRef<ComposerPopoverHandle>()}
        trigger={fileTrigger("")}
        cwd={null}
        slashCommands={commands}
        anchor={anchor}
        chatAgents={[]}
        onPick={jest.fn()}
        onDismiss={jest.fn()}
      />
    )
    expect(screen.queryByText("agentsSection")).not.toBeInTheDocument()
  })
})

describe("ComposerPopover — @skill: / @preset: namespaced pickers", () => {
  const chatSkills = [
    { id: "sk_a", name: "Concise", description: "Short answers" },
    { id: "sk_b", name: "Cite sources", description: "Cite everything" },
  ]
  const chatPresets = [
    { id: "p1", name: "Coding", description: "Engineering preset" },
    { id: "p2", name: "Writing", description: "Prose preset" },
  ] as unknown as React.ComponentProps<typeof ComposerPopover>["chatPresets"]

  function setupNamespaced(kind: "skill" | "preset", query: string, onPick = jest.fn()) {
    const anchor = document.createElement("div")
    document.body.appendChild(anchor)
    const ref = createRef<ComposerPopoverHandle>()
    render(
      <ComposerPopover
        ref={ref}
        trigger={{ kind, tokenStart: 0, tokenEnd: query.length + 1, query }}
        cwd={null}
        slashCommands={commands}
        anchor={anchor}
        chatSkills={chatSkills}
        chatPresets={chatPresets}
        onPick={onPick}
        onDismiss={jest.fn()}
      />
    )
    return { ref, onPick }
  }

  it("explains that multiple skills can be attached", () => {
    setupNamespaced("skill", "")
    expect(screen.getByText("multiSkillHint")).toBeInTheDocument()
  })

  it("lists enabled skills and fuzzy-filters by name", () => {
    setupNamespaced("skill", "")
    expect(rowTexts().some((t) => t.includes("Concise"))).toBe(true)
    expect(rowTexts().some((t) => t.includes("Cite sources"))).toBe(true)
  })

  it("confirm() picks a skill item (enable on pick, no text)", () => {
    const { ref, onPick } = setupNamespaced("skill", "cite")
    act(() => ref.current!.confirm())
    expect(onPick).toHaveBeenCalledWith({
      kind: "skill",
      skill: expect.objectContaining({ id: "sk_b", name: "Cite sources" }),
    })
  })

  it("lists presets and confirm() picks one", () => {
    const { ref, onPick } = setupNamespaced("preset", "writ")
    expect(rowTexts().some((t) => t.includes("Writing"))).toBe(true)
    act(() => ref.current!.confirm())
    expect(onPick).toHaveBeenCalledWith({
      kind: "preset",
      preset: expect.objectContaining({ id: "p2", name: "Writing" }),
    })
  })

  it("shows the empty message when no skills are available", () => {
    const anchor = document.createElement("div")
    document.body.appendChild(anchor)
    render(
      <ComposerPopover
        ref={createRef<ComposerPopoverHandle>()}
        trigger={{ kind: "skill", tokenStart: 0, tokenEnd: 1, query: "" }}
        cwd={null}
        slashCommands={commands}
        anchor={anchor}
        chatSkills={[]}
        onPick={jest.fn()}
        onDismiss={jest.fn()}
      />
    )
    expect(screen.getByText("noSkills")).toBeInTheDocument()
  })
})

describe("ComposerPopover — highlight, grouping & pinning", () => {
  function setupSlash(
    trigger: ComposerTrigger | null,
    extra: Partial<React.ComponentProps<typeof ComposerPopover>> = {}
  ) {
    const anchor = document.createElement("div")
    document.body.appendChild(anchor)
    const ref = createRef<ComposerPopoverHandle>()
    const onPick = (extra.onPick as jest.Mock) ?? jest.fn()
    render(
      <ComposerPopover
        ref={ref}
        trigger={trigger}
        cwd={null}
        slashCommands={commands}
        anchor={anchor}
        onPick={onPick}
        onDismiss={jest.fn()}
        {...extra}
      />
    )
    return { ref, onPick }
  }

  it("highlights the matched characters in a row name", () => {
    setupSlash(slashTrigger("co"))
    // "cost" row → "co" wrapped in a <mark>.
    const marks = document.querySelectorAll("mark")
    expect(Array.from(marks).some((m) => m.textContent === "co")).toBe(true)
  })

  it("renders Pinned / Recent / category section headers for an empty query", () => {
    setupSlash(slashTrigger(""), {
      pinnedCommands: ["model"],
      recentCommands: ["cost"],
      onTogglePin: jest.fn(),
    })
    expect(screen.getByText("Pinned")).toBeInTheDocument()
    expect(screen.getByText("Recent")).toBeInTheDocument()
    // Remaining uncategorized commands fall under "Other".
    expect(screen.getByText("Other")).toBeInTheDocument()
  })

  it("gives section headers consistent separation from the preceding group", () => {
    setupSlash(slashTrigger(""), {
      pinnedCommands: ["model"],
      recentCommands: ["cost"],
      onTogglePin: jest.fn(),
    })

    const headers = ["Pinned", "Recent", "Other"].map((label) =>
      screen.getByText(label).closest("li")
    )
    expect(headers.every(Boolean)).toBe(true)
    for (const header of headers) {
      expect(header).toHaveClass("mt-2", "py-1.5")
      expect(header).not.toHaveClass("first:mt-0")
    }
  })

  it("keyboard nav skips headers — confirm() at index 0 picks the pinned command", () => {
    const { ref, onPick } = setupSlash(slashTrigger(""), {
      pinnedCommands: ["model"],
      recentCommands: ["cost"],
      onTogglePin: jest.fn(),
    })
    act(() => {
      ref.current!.confirm()
    })
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slash",
        command: expect.objectContaining({ name: "model" }),
        group: "pinned",
      })
    )
  })

  it("renders a pin button that toggles without picking the command", () => {
    const onTogglePin = jest.fn()
    const onPick = jest.fn()
    setupSlash(slashTrigger(""), { onTogglePin, onPick })
    // Pin a command via its aria-label (mocked t echoes the key + params).
    const pinButtons = screen.getAllByRole("button", { name: /pinAction/ })
    expect(pinButtons.length).toBeGreaterThan(0)
    act(() => {
      pinButtons[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(onTogglePin).toHaveBeenCalledTimes(1)
    // The mousedown must NOT bubble into a row pick.
    expect(onPick).not.toHaveBeenCalled()
  })

  it("shows an unpin affordance for an already-pinned command", () => {
    setupSlash(slashTrigger(""), {
      pinnedCommands: ["model"],
      onTogglePin: jest.fn(),
    })
    expect(screen.getAllByRole("button", { name: /unpinAction/ }).length).toBeGreaterThan(0)
  })
})

describe("ComposerPopover — remote documents", () => {
  const provider = { id: "lark", mentionPrefix: "lark:" } as RemoteDocSearchState["provider"]

  function docTrigger(query: string): ComposerTrigger {
    return {
      kind: "doc",
      namespace: "lark:",
      tokenStart: 0,
      tokenEnd: 6 + query.length,
      query,
    }
  }

  it("lists the provider's hits and labels each document kind", () => {
    useRemoteDocSearchMock.mockReturnValue(
      docSearchState({
        provider,
        hostSupported: true,
        accounts: [{ id: "cai_1", label: "Acme" }],
        accountId: "cai_1",
        items: [
          { providerId: "lark", kind: "doc", id: "d1", title: "Spec" },
          { providerId: "lark", kind: "bitable", id: "b1", title: "Roadmap" },
        ],
      })
    )
    setup(docTrigger("spec"))
    const texts = rowTexts()
    expect(texts.some((t) => t.includes("Spec") && t.includes("kind.doc"))).toBe(true)
    expect(texts.some((t) => t.includes("Roadmap") && t.includes("kind.bitable"))).toBe(true)
  })

  it("hands the picked document its provider and account", () => {
    const onPick = jest.fn()
    useRemoteDocSearchMock.mockReturnValue(
      docSearchState({
        provider,
        hostSupported: true,
        accounts: [{ id: "cai_1", label: "Acme" }],
        accountId: "cai_1",
        items: [{ providerId: "lark", kind: "doc", id: "d1", title: "Spec" }],
      })
    )
    const { ref } = setup(docTrigger("spec"), onPick)
    act(() => ref.current?.confirm())
    expect(onPick).toHaveBeenCalledWith({
      kind: "doc",
      providerId: "lark",
      accountId: "cai_1",
      doc: { providerId: "lark", kind: "doc", id: "d1", title: "Spec" },
    })
  })

  it("explains the desktop-only limitation instead of showing an empty list", () => {
    useRemoteDocSearchMock.mockReturnValue(docSearchState({ provider, hostSupported: false }))
    setup(docTrigger("spec"))
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.getByText("picker.hostUnsupported")).toBeInTheDocument()
  })

  it("asks the user to connect an account when none is selected", () => {
    useRemoteDocSearchMock.mockReturnValue(
      docSearchState({ provider, hostSupported: true, accounts: [], accountId: null })
    )
    setup(docTrigger("spec"))
    expect(screen.getByText("picker.noAccount")).toBeInTheDocument()
  })

  it("surfaces a provider error over the generic no-matches message", () => {
    useRemoteDocSearchMock.mockReturnValue(
      docSearchState({
        provider,
        hostSupported: true,
        accounts: [{ id: "cai_1", label: "Acme" }],
        accountId: "cai_1",
        error: { code: "noPermission" },
      })
    )
    setup(docTrigger("spec"))
    // The next-intl mock renders `key:<params>`; the params object is always
    // passed so a message with placeholders keeps working.
    expect(screen.getByText("errors.noPermission:{}")).toBeInTheDocument()
  })

  it("tells a search-less provider's user to paste a link", () => {
    useRemoteDocSearchMock.mockReturnValue(
      docSearchState({
        provider,
        hostSupported: true,
        accounts: [{ id: "cai_1", label: "Acme" }],
        accountId: "cai_1",
        linkOnly: true,
      })
    )
    setup(docTrigger(""))
    expect(screen.getByText("picker.linkOnlyHint")).toBeInTheDocument()
  })

  it("shows the single connected account in the footer", () => {
    useRemoteDocSearchMock.mockReturnValue(
      docSearchState({
        provider,
        hostSupported: true,
        accounts: [{ id: "cai_1", label: "Acme Feishu" }],
        accountId: "cai_1",
      })
    )
    setup(docTrigger(""))
    expect(screen.getByTestId("composer-doc-account")).toHaveTextContent("Acme Feishu")
  })
})
