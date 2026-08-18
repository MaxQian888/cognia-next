/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

// cmdk's filtering relies on scrollIntoView / ResizeObserver, absent in jsdom.
Element.prototype.scrollIntoView = jest.fn()
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const rows: ChatSession[] = []
const toArray = jest.fn(async () => rows)
const filter = jest.fn((pred: (s: ChatSession) => boolean) => ({
  toArray: async () => (await toArray()).filter(pred),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessions: { filter: (pred: (s: ChatSession) => boolean) => filter(pred) } }),
}))

// Same shape as `dexie-react-hooks`: run the querier, hand back its resolved
// value; `undefined` while pending. Re-runs whenever the deps change.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[], initial: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react") as typeof import("react")
    const [value, setValue] = React.useState(initial)
    React.useEffect(() => {
      let live = true
      void querier().then((v) => {
        if (live) setValue(v)
      })
      return () => {
        live = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

import {
  ConversationPickerDialog,
  isPlatformBoundSession,
  listPlatformBoundSessions,
  type PlatformBoundSession,
} from "./conversation-picker-dialog"

const bound = (
  id: string,
  title: string,
  platform: string,
  conversationKey: string,
  updatedAt: number
): PlatformBoundSession =>
  ({
    id,
    title,
    createdAt: 1,
    updatedAt,
    platformBinding: {
      adapterId: "a1",
      platform,
      conversationKey,
      conversationRef: { platform, adapterId: "a1" },
    },
  }) as unknown as PlatformBoundSession

const alice = bound("s1", "Alice", "telegram", "telegram:a1:1001", 20)
const opsRoom = bound("s2", "", "slack", "slack:a1:C1", 30)
const plain = { id: "p1", title: "Plain chat", createdAt: 1, updatedAt: 40 } as ChatSession

beforeEach(() => {
  rows.splice(0, rows.length, alice, opsRoom, plain)
  toArray.mockClear()
  filter.mockClear()
})

describe("listPlatformBoundSessions / isPlatformBoundSession", () => {
  it("keeps only bound sessions, newest first", async () => {
    const out = await listPlatformBoundSessions()
    expect(out.map((s) => s.id)).toEqual(["s2", "s1"])
    expect(isPlatformBoundSession(plain)).toBe(false)
    expect(isPlatformBoundSession(alice)).toBe(true)
  })
})

describe("ConversationPickerDialog", () => {
  it("lists bound conversations from Dexie with title, key and platform badge", async () => {
    render(<ConversationPickerDialog open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId("conversation-picker-item-s1")).toBeInTheDocument()
    )
    expect(screen.getByTestId("conversation-picker-item-s2")).toHaveTextContent("slack:a1:C1")
    expect(screen.getByTestId("platform-badge-telegram")).toBeInTheDocument()
    expect(screen.getByTestId("platform-badge-slack")).toBeInTheDocument()
    // Newest first.
    const items = screen.getAllByRole("option")
    expect(items[0]).toHaveAttribute("data-testid", "conversation-picker-item-s2")
    // The plain session never appears.
    expect(screen.queryByText("Plain chat")).not.toBeInTheDocument()
  })

  it("closes, then hands the chosen session to onSelect", async () => {
    const onSelect = jest.fn()
    const onOpenChange = jest.fn()
    render(<ConversationPickerDialog open onOpenChange={onOpenChange} onSelect={onSelect} />)
    await waitFor(() =>
      expect(screen.getByTestId("conversation-picker-item-s1")).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId("conversation-picker-item-s1"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).toHaveBeenCalledWith(alice)
    expect(onOpenChange.mock.invocationCallOrder[0]).toBeLessThan(
      onSelect.mock.invocationCallOrder[0]!
    )
  })

  it("filters by title, key or platform, and shows the no-match empty state", async () => {
    render(<ConversationPickerDialog open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId("conversation-picker-item-s1")).toBeInTheDocument()
    )
    const input = screen.getByTestId("conversation-picker-input")
    fireEvent.change(input, { target: { value: "slack" } })
    await waitFor(() =>
      expect(screen.queryByTestId("conversation-picker-item-s1")).not.toBeInTheDocument()
    )
    expect(screen.getByTestId("conversation-picker-item-s2")).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "zzz-nothing" } })
    await waitFor(() => expect(screen.getByText("No matching conversations.")).toBeInTheDocument())
  })

  it("explains when there are no platform-bound conversations at all", async () => {
    rows.splice(0, rows.length, plain)
    render(<ConversationPickerDialog open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    await waitFor(() =>
      expect(screen.getByText("No platform-bound conversations yet.")).toBeInTheDocument()
    )
  })

  it("takes an explicit session list, leaves out the excluded one, and skips Dexie", async () => {
    render(
      <ConversationPickerDialog
        open
        onOpenChange={jest.fn()}
        onSelect={jest.fn()}
        sessions={[alice, opsRoom]}
        excludeSessionId="s1"
      />
    )
    expect(screen.getByTestId("conversation-picker-item-s2")).toBeInTheDocument()
    expect(screen.queryByTestId("conversation-picker-item-s1")).not.toBeInTheDocument()
    await act(async () => {})
    expect(filter).not.toHaveBeenCalled()
  })

  it("does not read Dexie while closed", async () => {
    render(<ConversationPickerDialog open={false} onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    await act(async () => {})
    expect(filter).not.toHaveBeenCalled()
    expect(screen.queryByTestId("conversation-picker-input")).not.toBeInTheDocument()
  })
})
