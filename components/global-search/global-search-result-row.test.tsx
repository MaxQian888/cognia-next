/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Command } from "cmdk"

import type { GlobalSearchItem } from "@/lib/global-search/types"

import { GlobalSearchResultRow } from "./global-search-result-row"

const NOW = 1_750_000_000_000

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({
    relativeTime: (value: Date, now: Date) => `rel(${now.getTime() - value.getTime()})`,
    dateTime: (value: Date) => `abs(${value.getTime()})`,
  }),
  useNow: () => new Date(NOW),
}))

const base: GlobalSearchItem = {
  id: "session:1",
  kind: "session",
  title: "Deploy notes",
  titlePositions: [0, 1, 2],
  score: 1,
  action: { type: "open-session", sessionId: "1" },
}

function renderRow(item: GlobalSearchItem, onSelect = jest.fn()) {
  render(
    <Command shouldFilter={false}>
      <Command.List>
        <GlobalSearchResultRow item={item} onSelect={onSelect} showKind />
      </Command.List>
    </Command>
  )
  return onSelect
}

/** Same wrapper, with the secondary action wired. */
function renderReferenceableRow(
  item: GlobalSearchItem,
  { onSelect = jest.fn(), onReference }: { onSelect?: jest.Mock; onReference?: jest.Mock } = {}
) {
  render(
    <Command shouldFilter={false}>
      <Command.List>
        <GlobalSearchResultRow
          item={item}
          onSelect={onSelect}
          {...(onReference ? { onReference } : {})}
        />
      </Command.List>
    </Command>
  )
  return { onSelect, onReference }
}

describe("GlobalSearchResultRow", () => {
  it("renders title highlight, kind and selects on click", async () => {
    const onSelect = renderRow(base)
    const row = screen.getByTestId("global-search-row")
    expect(row).toHaveAttribute("data-kind", "session")
    expect(row.querySelectorAll("mark")).toHaveLength(1)
    expect(row.querySelector("mark")?.textContent).toBe("Dep")
    expect(screen.getByText("kinds.session")).toBeInTheDocument()
    await userEvent.setup().click(row)
    expect(onSelect).toHaveBeenCalledWith(base)
  })

  it("renders badges, subtitle, meta, relative and absolute time", () => {
    renderRow({
      ...base,
      kind: "message",
      subtitle: "the needle here",
      subtitlePositions: [4, 5, 6],
      meta: "You",
      timestamp: NOW - 1000,
      extra: { current: true, archived: true, occurrenceCount: 3, otherBranchCount: 2 },
    })
    expect(screen.getByText("badges.current")).toBeInTheDocument()
    expect(screen.getByText("badges.archived")).toBeInTheDocument()
    expect(screen.getByText('badges.occurrences:{"count":3}')).toBeInTheDocument()
    expect(screen.getByText('badges.branchCopies:{"count":2}')).toBeInTheDocument()
    expect(screen.getByText("You")).toBeInTheDocument()
    expect(screen.getByText("rel(1000)")).toBeInTheDocument()
    // Title and subtitle each carry their own highlight run.
    const marks = screen.getByTestId("global-search-row").querySelectorAll("mark")
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(["Dep", "nee"])
  })

  it("uses an absolute date for old timestamps and shows disabled reasons", () => {
    renderRow({
      ...base,
      timestamp: NOW - 400 * 86_400_000,
      extra: { disabledReason: "Desktop only", occurrenceCount: 1 },
    })
    expect(screen.getByText(`abs(${NOW - 400 * 86_400_000})`)).toBeInTheDocument()
    expect(screen.getByText("Desktop only")).toBeInTheDocument()
    expect(screen.getByTestId("global-search-row")).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByText(/badges.occurrences/)).toBeNull()
  })

  it("renders an avatar icon for people", () => {
    renderRow({
      ...base,
      kind: "character",
      icon: { avatar: { name: "Ada", avatarColor: "#f00", avatarEmoji: "🧠" } },
    })
    expect(screen.getByText("🧠")).toBeInTheDocument()
  })
})

describe("the reference control", () => {
  const messageItem = (over = {}) =>
    ({
      id: "message:m_1",
      kind: "message" as const,
      title: "Restacking",
      score: 1,
      extra: { sessionId: "s_1" },
      action: { type: "open-session", sessionId: "s_1", messageId: "m_1" },
      ...over,
    }) as never

  it("is absent when the host offers no composer to stage into", () => {
    renderReferenceableRow(messageItem())
    expect(screen.queryByTestId("global-search-reference")).toBeNull()
  })

  it("appears on a referenceable row", () => {
    renderReferenceableRow(messageItem(), { onReference: jest.fn() })
    expect(screen.getByTestId("global-search-reference")).toBeInTheDocument()
  })

  // The registry drew the line at "has a body a model can read".
  it("is absent on a row that cannot be referenced", () => {
    renderReferenceableRow(messageItem({ id: "workflow:w", kind: "workflow", extra: undefined }), {
      onReference: jest.fn(),
    })
    expect(screen.queryByTestId("global-search-reference")).toBeNull()
  })

  it("is absent on a disabled row", () => {
    renderReferenceableRow(
      messageItem({ extra: { sessionId: "s_1", disabledReason: "no host" } }),
      { onReference: jest.fn() }
    )
    expect(screen.queryByTestId("global-search-reference")).toBeNull()
  })

  // `CommandItem` selects on click, and selecting would open the row out from
  // under the reference.
  it("references without opening the row", () => {
    const onSelect = jest.fn()
    const onReference = jest.fn()
    renderReferenceableRow(messageItem(), { onSelect, onReference })
    fireEvent.mouseDown(screen.getByTestId("global-search-reference"))
    expect(onReference).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  // cmdk lowercases and trims `data-value`, so the dialog's ⌘↵ handler needs
  // the id verbatim.
  it("carries the item id verbatim for the keyboard path", () => {
    renderReferenceableRow(messageItem())
    expect(screen.getByTestId("global-search-row")).toHaveAttribute("data-item-id", "message:m_1")
  })
})
