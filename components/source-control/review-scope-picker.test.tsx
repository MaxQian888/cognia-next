/**
 * @jest-environment jsdom
 */

import * as ReactForMock from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"

import type { TurnReviewOption } from "@/hooks/git/use-session-turn-reviews"
import type { ReviewScopeChoice } from "@/types/review"

import { ReviewScopePicker, scopeChoiceKey } from "./review-scope-picker"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

// Radix menus need real pointer events; render every item inline instead and
// fire `onSelect` on click, which is the contract the picker depends on.
const RadioValue = ReactForMock.createContext<string | undefined>(undefined)
let openMenu: ((open: boolean) => void) | undefined
jest.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
    }: {
      children: React.ReactNode
      onOpenChange?: (open: boolean) => void
    }) => {
      openMenu = onOpenChange
      return <div>{children}</div>
    },
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    DropdownMenuRadioGroup: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <RadioValue.Provider value={value}>{children}</RadioValue.Provider>
    ),
    DropdownMenuRadioItem: function Item({
      value,
      children,
      onSelect,
      disabled,
      ...rest
    }: {
      value: string
      children: React.ReactNode
      onSelect?: () => void
      disabled?: boolean
      "data-testid"?: string
    }) {
      const current = ReactForMock.useContext(RadioValue)
      return (
        <button
          type="button"
          data-testid={rest["data-testid"]}
          data-checked={String(current === value)}
          disabled={disabled}
          onClick={() => onSelect?.()}
        >
          {children}
        </button>
      )
    },
  }
})

let mockTurns: TurnReviewOption[] = []
jest.mock("@/hooks/git/use-session-turn-reviews", () => ({
  useSessionTurnReviews: () => mockTurns,
}))

const gitLog = jest.fn()
const gitBranches = jest.fn()
const gitDefaultBranch = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitLog: (...args: unknown[]) => gitLog(...args),
  gitBranches: (...args: unknown[]) => gitBranches(...args),
  gitDefaultBranch: (...args: unknown[]) => gitDefaultBranch(...args),
}))

const turn = (ordinal: number, prompt: string | null = null): TurnReviewOption => ({
  runId: `run:${ordinal}`,
  ordinal,
  ts: ordinal,
  files: 2,
  added: 3,
  removed: 1,
  prompt,
})

function renderPicker(value: ReviewScopeChoice, extra: Record<string, unknown> = {}) {
  const onChange = jest.fn()
  render(
    <ReviewScopePicker
      value={value}
      onChange={onChange}
      rootDir="/repo"
      sessionId="s1"
      {...extra}
    />
  )
  return onChange
}

beforeEach(() => {
  mockTurns = [turn(2, "Fix login"), turn(1)]
  gitLog.mockReset().mockResolvedValue([
    {
      hash: "abcdef1234",
      shortHash: "abcdef1",
      summary: "feat: thing",
      body: "",
      authorName: "a",
      authorEmail: "a@x",
      authoredAtMs: 1,
      parents: [],
    },
  ])
  gitBranches.mockReset().mockResolvedValue([
    { name: "feature", isCurrent: true },
    { name: "dev", isCurrent: false },
    { name: "origin/HEAD", isCurrent: false },
    { name: "main", isCurrent: false },
  ])
  gitDefaultBranch.mockReset().mockResolvedValue({ branch: "main", source: "ref", exists: true })
})

describe("scopeChoiceKey", () => {
  it("encodes refs into distinct keys", () => {
    expect(scopeChoiceKey({ scope: "staged" })).toBe("staged")
    expect(scopeChoiceKey({ scope: "lastTurn", runId: "r" })).toBe("turn:r")
    expect(scopeChoiceKey({ scope: "commit", commitSha: "s" })).toBe("commit:s")
    expect(scopeChoiceKey({ scope: "branch", baseRef: "main", targetRef: "HEAD" })).toBe(
      "branch:main...HEAD"
    )
  })
})

describe("ReviewScopePicker", () => {
  it("labels the latest turn as Last turn and an earlier one by number", () => {
    renderPicker({ scope: "lastTurn", runId: "run:2" })
    expect(screen.getByTestId("review-scope-trigger")).toHaveTextContent("lastTurn")
  })

  it("labels an earlier turn by its ordinal", () => {
    renderPicker({ scope: "lastTurn", runId: "run:1" })
    expect(screen.getByTestId("review-scope-trigger")).toHaveTextContent('turn:{"ordinal":1}')
  })

  it("picks the latest turn and lists every turn with its prompt", () => {
    const onChange = renderPicker({ scope: "uncommitted" })
    fireEvent.click(screen.getByTestId("review-scope-last-turn"))
    expect(onChange).toHaveBeenCalledWith({ scope: "lastTurn", runId: "run:2" })
    expect(screen.getByTestId("review-scope-turn-2")).toHaveTextContent(
      'turnWithPrompt:{"ordinal":2,"prompt":"Fix login"}'
    )
    fireEvent.click(screen.getByTestId("review-scope-turn-1"))
    expect(onChange).toHaveBeenCalledWith({ scope: "lastTurn", runId: "run:1" })
  })

  it("disables Last turn when the conversation has no recorded turn", () => {
    mockTurns = []
    renderPicker({ scope: "uncommitted" })
    expect(screen.getByTestId("review-scope-last-turn")).toBeDisabled()
    expect(screen.queryByTestId("review-scope-turns")).toBeNull()
  })

  it("switches between working-tree scopes and marks the current one", () => {
    const onChange = renderPicker({ scope: "staged" }, { counts: { staged: 4 } })
    expect(screen.getByTestId("review-scope-staged")).toHaveAttribute("data-checked", "true")
    expect(screen.getByTestId("review-scope-staged")).toHaveTextContent("4")
    fireEvent.click(screen.getByTestId("review-scope-unstaged"))
    expect(onChange).toHaveBeenCalledWith({ scope: "unstaged" })
    // Re-picking the current scope is not a change.
    fireEvent.click(screen.getByTestId("review-scope-staged"))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("offers This conversation only when allowed", () => {
    renderPicker({ scope: "uncommitted" })
    expect(screen.queryByTestId("review-scope-conversation")).toBeNull()
  })

  it("loads commits and branches when the menu opens and picks them", async () => {
    const onChange = renderPicker({ scope: "uncommitted" }, { allowConversation: true })
    expect(screen.getByTestId("review-scope-conversation")).toBeInTheDocument()
    expect(gitLog).not.toHaveBeenCalled()
    await act(async () => {
      openMenu?.(true)
    })
    expect(gitLog).toHaveBeenCalledWith("/repo", 20, 0)
    fireEvent.click(screen.getByTestId("review-scope-commit-abcdef1"))
    expect(onChange).toHaveBeenCalledWith({ scope: "commit", commitSha: "abcdef1234" })

    // Trunk first, then the other branches; never the current one or a symbolic HEAD.
    const bases = screen
      .getAllByTestId(/^review-scope-branch-/)
      .map((node) => node.getAttribute("data-testid"))
    expect(bases).toEqual(["review-scope-branch-main", "review-scope-branch-dev"])
    fireEvent.click(screen.getByTestId("review-scope-branch-main"))
    expect(onChange).toHaveBeenCalledWith({ scope: "branch", baseRef: "main", targetRef: "HEAD" })
  })

  it("says so when the refs cannot be read", async () => {
    gitLog.mockRejectedValue(new Error("no repo"))
    renderPicker({ scope: "uncommitted" })
    await act(async () => {
      openMenu?.(true)
    })
    expect(screen.getAllByText("refsFailed")).toHaveLength(2)
  })

  it("labels commit and branch values by their ref", () => {
    renderPicker({ scope: "commit", commitSha: "abcdef1234" })
    expect(screen.getByTestId("review-scope-trigger")).toHaveTextContent(
      'commitValue:{"sha":"abcdef1"}'
    )
  })
})
