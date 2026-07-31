/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

const listCharactersMock = jest.fn(async () => [] as unknown[])
const listSessionsMock = jest.fn(async () => [] as unknown[])

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${Object.values(vals).join(",")}` : key,
}))
jest.mock("@/lib/db/characters", () => ({ listCharacters: () => listCharactersMock() }))
jest.mock("@/lib/db/sessions", () => ({ listSessions: () => listSessionsMock() }))

// Resolve the live query synchronously against whatever the mocks return.
let liveResults: unknown[][] = []
let liveCallCount = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => {
    const value = liveResults[liveCallCount] ?? []
    liveCallCount += 1
    return value
  },
}))

import { AccountUsageChips, useAccountUsageIndex } from "./account-usage-chips"

function Harness({ accountId }: { accountId: string }) {
  const index = useAccountUsageIndex()
  return <AccountUsageChips accountId={accountId} usage={index.get(accountId)} />
}

function setDb(characters: unknown[], sessions: unknown[]) {
  liveResults = [characters, sessions]
  liveCallCount = 0
}

beforeEach(() => {
  liveResults = []
  liveCallCount = 0
})

describe("useAccountUsageIndex", () => {
  it("groups characters and sessions by the account they pin to", () => {
    setDb(
      [
        { id: "c1", name: "Ada", accountIdOverride: "acc-1" },
        { id: "c2", name: "Bob", accountIdOverride: "acc-2" },
        { id: "c3", name: "Unpinned" },
      ],
      [
        { id: "s1", title: "First", accountId: "acc-1" },
        { id: "s2", title: "", accountId: "acc-1" },
      ]
    )
    render(<Harness accountId="acc-1" />)

    expect(screen.getByTestId("account-usage-character-c1")).toBeInTheDocument()
    expect(screen.queryByTestId("account-usage-character-c2")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-usage-session-s1")).toBeInTheDocument()
  })

  it("falls back to a short id when a session has no title", () => {
    setDb([], [{ id: "abcdef123456", title: "", accountId: "acc-1" }])
    render(<Harness accountId="acc-1" />)
    expect(screen.getByTestId("account-usage-session-abcdef123456")).toHaveTextContent("abcdef12")
  })
})

describe("AccountUsageChips", () => {
  it("renders nothing when the account is referenced by nothing", () => {
    setDb([], [])
    const { container } = render(<Harness accountId="acc-1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("caps the chips and collapses the rest into a +N badge", () => {
    // An account pinned to dozens of sessions used to render a badge each,
    // blowing out the row width.
    setDb(
      [],
      Array.from({ length: 12 }, (_, i) => ({
        id: `s${i}`,
        title: `Session ${i}`,
        accountId: "acc-1",
      }))
    )
    render(<Harness accountId="acc-1" />)

    expect(screen.getAllByTestId(/^account-usage-session-/)).toHaveLength(3)
    expect(screen.getByTestId("account-usage-more-acc-1")).toHaveTextContent("9")
  })

  it("gives characters the visible slots before sessions", () => {
    setDb(
      Array.from({ length: 4 }, (_, i) => ({
        id: `c${i}`,
        name: `Char ${i}`,
        accountIdOverride: "acc-1",
      })),
      [{ id: "s1", title: "Session", accountId: "acc-1" }]
    )
    render(<Harness accountId="acc-1" />)

    expect(screen.getAllByTestId(/^account-usage-character-/)).toHaveLength(3)
    expect(screen.queryByTestId("account-usage-session-s1")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-usage-more-acc-1")).toHaveTextContent("2")
  })

  it("shows no overflow badge when everything fits", () => {
    setDb([{ id: "c1", name: "Ada", accountIdOverride: "acc-1" }], [])
    render(<Harness accountId="acc-1" />)
    expect(screen.queryByTestId("account-usage-more-acc-1")).not.toBeInTheDocument()
  })
})
