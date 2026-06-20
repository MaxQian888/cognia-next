/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { render, screen, act } from "@testing-library/react"
import { ComposerPopover, type ComposerPopoverHandle } from "./composer-popover"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ComposerTrigger } from "./composer-trigger"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

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
    expect(onPick).toHaveBeenCalledWith({
      kind: "slash",
      command: expect.objectContaining({ name: "cost" }),
    })
  })

  it("navigate() moves the highlight before confirming", () => {
    const { ref, onPick } = setup(slashTrigger("co"))
    act(() => {
      ref.current!.navigate(1)
    })
    act(() => {
      ref.current!.confirm()
    })
    expect(onPick).toHaveBeenCalledWith({
      kind: "slash",
      command: expect.objectContaining({ name: "compact" }),
    })
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
    expect(onPick).toHaveBeenCalledWith({
      kind: "slash",
      command: expect.objectContaining({ name: "compact" }),
    })
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
