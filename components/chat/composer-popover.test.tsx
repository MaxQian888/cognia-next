/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { render, screen, act } from "@testing-library/react"
import { ComposerPopover, type ComposerPopoverHandle } from "./composer-popover"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ComposerTrigger } from "./composer-trigger"

// Stable `t` per the real next-intl contract (its `t` identity is memoized).
// A fresh function each render would churn effect deps (the file-search effect
// lists `t`) and loop — that's a mock artifact, not component behaviour.
jest.mock("next-intl", () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key
  return { useTranslations: () => t }
})

// Descriptions are blank (except /review) so the secondary description match
// can't pull extra commands into a short-query result — keeps name-ranking
// assertions deterministic. The "diff" test exercises the description path.
const commands = [
  { name: "clear", description: "", scope: "builtin" },
  { name: "compact", description: "", scope: "builtin" },
  { name: "cost", description: "", scope: "builtin" },
  { name: "model", description: "", scope: "builtin" },
  { name: "review", description: "Inspect the diff", scope: "builtin" },
] as SlashCommand[]

function slashTrigger(query: string): ComposerTrigger {
  return { kind: "slash", tokenStart: 0, tokenEnd: query.length + 1, query }
}

function setup(trigger: ComposerTrigger | null, onPick = jest.fn()) {
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
      onPick={onPick}
      onDismiss={jest.fn()}
    />
  )
  return { ref, onPick }
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

  it("caps the popover width at 480px so it can't spill past a narrow panel", () => {
    setup(slashTrigger(""))
    const content = screen.getByRole("dialog")
    expect(content.className).toContain("max-w-[480px]")
    expect(content.className).toContain("var(--radix-popper-anchor-width)")
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
