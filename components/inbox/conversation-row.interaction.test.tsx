/**
 * @jest-environment jsdom
 *
 * Interaction / composition layer for ConversationRow.
 *
 * Unlike `conversation-row.test.tsx` (which re-declares its own `makeItem`
 * fixture), this file REUSES the Storybook stories as the source of fixtures:
 * the same `args` that drive the visual preview drive these tests, so there is
 * one fixture to maintain, not two. We then drive real user clicks with
 * `userEvent` and compose several story states into one list to verify they
 * coexist the way the real Inbox pane renders them.
 *
 * Why not `composeStories(...)`? That portable-stories helper imports
 * `@storybook/nextjs-vite` (ESM-only) into the test, which jest's
 * `transformIgnorePatterns` skips — it throws "Cannot use import statement
 * outside a module" without a jest-config change. The story FILE itself is safe
 * to import: its `import type { Meta, StoryObj }` is erased at compile, and
 * `storybook/test` (`fn`) already resolves under jest. So we read the story
 * `args` directly. For decorator-less stories like these, merging
 * `meta.args` + `story.args` is exactly what `composeStories` would compute —
 * and next-intl is globally mocked in jest.setup.ts, so no provider is needed.
 */

import type { ReactElement } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// The story file imports `fn` from `storybook/test`, which ships ESM-only and
// trips jest's transform ("Cannot use import statement outside a module"). A
// factory mock means jest never loads the real module — the story just gets a
// spy factory. Local to this file, so no jest.config change is needed.
jest.mock("storybook/test", () => ({ fn: () => jest.fn() }))

import { TooltipProvider } from "@/components/ui/tooltip"
import { ConversationRow, type ConversationRowProps } from "./conversation-row"
import * as stories from "./conversation-row.stories"

// Mirror the app's global provider stack. ConversationRow's computer-use chip
// renders a Radix Tooltip that needs a TooltipProvider ancestor (mounted in
// app/layout.tsx in prod, supplied by .storybook/preview.tsx in Storybook).
// `composeStories` would apply that decorator automatically; doing the reuse by
// hand, we wrap it ourselves. next-intl is globally mocked in jest.setup.ts.
const renderRow = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

// Resolve a story to its effective props the way Storybook layers args:
// component-level `meta.args` underneath, the story's own `args` on top.
const meta = stories.default
type StoryArgs = Partial<ConversationRowProps>
const argsOf = (story: { args?: StoryArgs }): ConversationRowProps =>
  ({ ...(meta.args as StoryArgs), ...(story.args ?? {}) }) as ConversationRowProps

// The conversationKey baked into the stories' fixture (`makeItem`).
const CK = "slack:a1:C1"
const ROW = { name: /Open conversation: Acme Corp/i }

describe("ConversationRow — interaction (story-fixture reuse)", () => {
  it("fires onSelect with the conversationKey on a real user click", async () => {
    const user = userEvent.setup({ skipHover: true })
    const onSelect = jest.fn()
    // Reuse the story's `item` fixture; override only the callback.
    renderRow(<ConversationRow {...argsOf(stories.Default)} onSelect={onSelect} />)

    await user.click(screen.getByRole("button", ROW))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(CK)
  })

  it("does not fire onSelect until the row is actually clicked", () => {
    const onSelect = jest.fn()
    renderRow(<ConversationRow {...argsOf(stories.Default)} onSelect={onSelect} />)

    expect(onSelect).not.toHaveBeenCalled()
  })

  it("composes several story states into one list and renders each faithfully", async () => {
    const user = userEvent.setup({ skipHover: true })
    const onSelect = jest.fn()

    // A realistic Inbox slice — plain, unread, pinned, and drafts+computer-use —
    // all reused straight from the stories' args.
    const { container } = renderRow(
      <div role="list">
        <ConversationRow {...argsOf(stories.Default)} onSelect={onSelect} />
        <ConversationRow {...argsOf(stories.Unread)} onSelect={onSelect} />
        <ConversationRow {...argsOf(stories.Pinned)} onSelect={onSelect} />
        <ConversationRow {...argsOf(stories.WithDraftsAndComputerUse)} onSelect={onSelect} />
      </div>
    )

    // Four clickable rows coexist.
    const rows = screen.getAllByRole("button", ROW)
    expect(rows).toHaveLength(4)

    // Exactly one pinned row (from the `Pinned` story).
    expect(container.querySelectorAll("svg.lucide-pin")).toHaveLength(1)

    // Exactly one draft badge (from `WithDraftsAndComputerUse`, draftCount: 2).
    expect(screen.getAllByTestId(`conversation-row-draft-${CK}`)).toHaveLength(1)

    // Clicking the last row still routes the conversationKey through onSelect.
    await user.click(rows[3]!)
    expect(onSelect).toHaveBeenCalledWith(CK)
  })
})
