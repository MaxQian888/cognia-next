/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import { MemoryLearnedChip, MemoryRecalledChip } from "./memory-chips"
import { useLearnedMemories, useRecalledMemories } from "@/hooks/memory/use-message-memories"
import { manageMemory } from "@/lib/memory/control-plane/manage"
import { usePlatform } from "@/hooks/use-platform"
import { toast } from "sonner"
import type { SourcesPart } from "@/lib/claude/parts-extensions"
import type { Memory } from "@/types/memory/memory"

jest.mock("motion/react", () => jest.requireActual("../../__mocks__/motion-react.js"))

jest.mock("@/hooks/memory/use-message-memories", () => ({
  useLearnedMemories: jest.fn(() => []),
  useRecalledMemories: jest.fn(() => []),
}))
jest.mock("@/lib/memory/control-plane/manage", () => ({
  manageMemory: jest.fn(async () => ({ ok: true })),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))

const mockLearned = useLearnedMemories as jest.Mock
const mockRecalled = useRecalledMemories as jest.Mock
const mockManage = manageMemory as jest.Mock
const mockPlatform = usePlatform as jest.Mock
const mockToastError = toast.error as jest.Mock

function memory(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    text: "User prefers pnpm",
    type: "semantic",
    status: "active",
    scope: "global",
    importance: 5,
    tags: [],
    pinned: false,
    provenance: "user",
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    version: 1,
    ...over,
  } as Memory
}

function renderIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function sourcesPart(over: Partial<SourcesPart> = {}): SourcesPart {
  return {
    type: "sources",
    sources: [
      {
        id: "memory-m1",
        title: "User prefers pnpm",
        snippet: "User prefers pnpm",
        origin: "memory",
        score: 0.82,
      },
    ],
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLearned.mockReturnValue([])
  mockRecalled.mockReturnValue([])
  mockManage.mockResolvedValue({ ok: true })
  mockPlatform.mockReturnValue("web")
})

describe("MemoryLearnedChip", () => {
  it("renders nothing when the message taught nothing", () => {
    const { container } = renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    expect(container.firstChild).toBeNull()
  })

  it("shows the count and lists learned memories in the popover", async () => {
    const user = userEvent.setup()
    mockLearned.mockReturnValue([memory(), memory({ id: "m2", text: "Uses Tailwind v4" })])
    renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    expect(screen.getByText("Learned 2 memories")).toBeInTheDocument()
    await user.click(screen.getByTestId("memory-learned-chip"))
    expect(await screen.findByText("Learned from this reply")).toBeInTheDocument()
    expect(screen.getByText("User prefers pnpm")).toBeInTheDocument()
    expect(screen.getByText("Uses Tailwind v4")).toBeInTheDocument()
  })

  it("undo soft-invalidates via manageMemory", async () => {
    const user = userEvent.setup()
    mockLearned.mockReturnValue([memory()])
    renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    await user.click(screen.getByTestId("memory-learned-chip"))
    await user.click(await screen.findByRole("button", { name: "Undo — forget this memory" }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "invalidate", id: "m1" })
  })

  it("renders an undone row without edit/undo actions", async () => {
    const user = userEvent.setup()
    mockLearned.mockReturnValue([memory({ status: "invalidated" })])
    renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    await user.click(screen.getByTestId("memory-learned-chip"))
    expect(await screen.findByText("Undone")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit memory" })).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Undo — forget this memory" })
    ).not.toBeInTheDocument()
  })

  it("edits the text inline and saves the trimmed patch", async () => {
    const user = userEvent.setup()
    mockLearned.mockReturnValue([memory()])
    renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    await user.click(screen.getByTestId("memory-learned-chip"))
    await user.click(await screen.findByRole("button", { name: "Edit memory" }))
    const textarea = screen.getByRole("textbox", { name: "Edit memory text" })
    await user.clear(textarea)
    await user.type(textarea, "  User prefers pnpm over npm  ")
    await user.click(screen.getByRole("button", { name: /Save/ }))
    expect(mockManage).toHaveBeenCalledWith({
      kind: "update",
      id: "m1",
      patch: { text: "User prefers pnpm over npm" },
    })
  })

  it("surfaces a toast when the mutation is rejected", async () => {
    const user = userEvent.setup()
    mockLearned.mockReturnValue([memory()])
    mockManage.mockResolvedValue({ ok: false, reason: "pii_blocked" })
    renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    await user.click(screen.getByTestId("memory-learned-chip"))
    await user.click(await screen.findByRole("button", { name: "Undo — forget this memory" }))
    expect(mockToastError).toHaveBeenCalledWith(
      "Blocked: the new text contains personal information"
    )
  })

  it("deep-links into the memory console", async () => {
    const user = userEvent.setup()
    mockLearned.mockReturnValue([memory()])
    renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    await user.click(screen.getByTestId("memory-learned-chip"))
    await user.click(await screen.findByRole("button", { name: "Open in memory console" }))
    expect(mockPush).toHaveBeenCalledWith("/memory?id=m1")
  })

  it("opens a drawer instead of a popover on mobile", async () => {
    const user = userEvent.setup()
    mockPlatform.mockReturnValue("mobile")
    mockLearned.mockReturnValue([memory()])
    renderIntl(<MemoryLearnedChip messageId="msg-1" />)
    await user.click(screen.getByTestId("memory-learned-chip"))
    expect(await screen.findByText("Learned from this reply")).toBeInTheDocument()
  })
})

describe("MemoryRecalledChip", () => {
  it("renders nothing without memory sources or a degraded flag", () => {
    const { container } = renderIntl(<MemoryRecalledChip part={{ type: "sources", sources: [] }} />)
    expect(container.firstChild).toBeNull()
  })

  it("lists recalled memories with live text and score", async () => {
    const user = userEvent.setup()
    mockRecalled.mockReturnValue([{ id: "m1", memory: memory({ text: "Live row text" }) }])
    renderIntl(<MemoryRecalledChip part={sourcesPart()} />)
    expect(screen.getByText("Recalled 1 memory")).toBeInTheDocument()
    await user.click(screen.getByTestId("memory-recalled-chip"))
    expect(await screen.findByText("Live row text")).toBeInTheDocument()
    expect(screen.getByText("82%")).toBeInTheDocument()
  })

  it("falls back to the persisted snippet for deleted rows", async () => {
    const user = userEvent.setup()
    mockRecalled.mockReturnValue([{ id: "m1", memory: undefined }])
    renderIntl(<MemoryRecalledChip part={sourcesPart()} />)
    await user.click(screen.getByTestId("memory-recalled-chip"))
    expect(await screen.findByText("User prefers pnpm")).toBeInTheDocument()
    expect(screen.getByText("Deleted from memory")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open in memory console" })).not.toBeInTheDocument()
  })

  it("shows budget, truncation and degraded notices", async () => {
    const user = userEvent.setup()
    mockRecalled.mockReturnValue([{ id: "m1", memory: memory() }])
    renderIntl(
      <MemoryRecalledChip
        part={sourcesPart({
          memoryBudget: { limit: 900, used: 620, truncated: true },
          memoryDegraded: true,
        })}
      />
    )
    await user.click(screen.getByTestId("memory-recalled-chip"))
    expect(await screen.findByText(/Context budget: 620\/900 tokens/)).toBeInTheDocument()
    expect(screen.getByText(/truncated/)).toBeInTheDocument()
    expect(
      screen.getByText("Memory retrieval was degraded this turn (keyword-only fallback).")
    ).toBeInTheDocument()
  })

  it("renders the chip for a degraded turn even with zero recalled items", () => {
    renderIntl(<MemoryRecalledChip part={{ type: "sources", sources: [], memoryDegraded: true }} />)
    expect(screen.getByText("No memories recalled")).toBeInTheDocument()
  })
})
