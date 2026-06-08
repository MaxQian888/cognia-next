/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

beforeAll(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    })
  }
})

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

// Sessions live-query (titles map). usePendingDrafts is mocked separately.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

const mockDrafts = jest.fn()
jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDrafts: () => mockDrafts(),
}))

jest.mock("./platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => <span data-testid={`badge-${platform}`} />,
}))

// DraftEditor owns the approve/enqueue flow + many sub-deps; stub it.
jest.mock("./draft-editor", () => ({
  DraftEditor: ({ draft }: { draft: { id: string } }) => <div data-testid={`editor-${draft.id}`} />,
}))

import { DraftCenter } from "./draft-center"

const DRAFTS = [
  { id: "d1", conversationKey: "slack:a1:C1", status: "pending", createdAt: 3, segments: [] },
  { id: "d2", conversationKey: "slack:a1:C1", status: "pending", createdAt: 2, segments: [] },
  { id: "d3", conversationKey: "lark:a2:U9", status: "pending", createdAt: 1, segments: [] },
]

describe("DraftCenter", () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockDrafts.mockReturnValue(DRAFTS)
  })

  it("renders an empty state when there are no pending drafts", () => {
    mockDrafts.mockReturnValue([])
    render(<DraftCenter />)
    expect(screen.getByTestId("draft-center-empty")).toBeInTheDocument()
    expect(screen.getByText("No drafts waiting for review")).toBeInTheDocument()
  })

  it("groups drafts by conversation and renders an editor per draft", () => {
    render(<DraftCenter />)
    expect(screen.getByTestId("draft-group-slack:a1:C1")).toBeInTheDocument()
    expect(screen.getByTestId("draft-group-lark:a2:U9")).toBeInTheDocument()
    expect(screen.getByTestId("editor-d1")).toBeInTheDocument()
    expect(screen.getByTestId("editor-d2")).toBeInTheDocument()
    expect(screen.getByTestId("editor-d3")).toBeInTheDocument()
  })

  it("derives the platform badge from the conversationKey", () => {
    render(<DraftCenter />)
    expect(screen.getByTestId("badge-slack")).toBeInTheDocument()
    expect(screen.getByTestId("badge-lark")).toBeInTheDocument()
  })

  it("the group Open action navigates to the conversation", () => {
    render(<DraftCenter />)
    fireEvent.click(screen.getByTestId("draft-group-open-slack:a1:C1"))
    expect(mockPush).toHaveBeenCalledWith("/inbox/c?key=slack%3Aa1%3AC1")
  })
})
