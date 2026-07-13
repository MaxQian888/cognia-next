// Coverage for the store-connected cost-badge wrapper: it aggregates the
// active session's in-memory usage and hides itself when there is none.

import { render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { SessionCostBadgeLive, aggregateUsage } from "./session-cost-badge-live"

// The inner badge reads a Dexie liveQuery for the per-model popover breakdown.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}))
jest.mock("@/lib/db/session-usage", () => ({
  listUsageForSession: jest.fn(),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

// Drive the store selector off a mutable state object. The real `useShallow`
// runs (not mocked) so the bail-out wrapping is exercised under render.
// `getState` backs the signature-gated aggregate read in the component.
let storeState: { messages: UIMessage[] }
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign((sel: (s: { messages: UIMessage[] }) => unknown) => sel(storeState), {
    getState: () => storeState,
  }),
}))

const tokens = (input: string, output: string) => `Tokens ${input}/${output}`

const msgWithUsage = (id: string, usage: Record<string, number>): UIMessage =>
  ({ id, role: "assistant", parts: [], metadata: { usage } }) as unknown as UIMessage

beforeEach(() => {
  storeState = { messages: [] }
})

describe("SessionCostBadgeLive", () => {
  it("renders nothing when no message carries usage", () => {
    storeState = { messages: [{ id: "u1", role: "user", parts: [] } as unknown as UIMessage] }
    const { container } = render(<SessionCostBadgeLive sessionId="s1" tokensLabel={tokens} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders summed in-memory tokens when usage is present", () => {
    storeState = {
      messages: [
        msgWithUsage("a", { inputTokens: 1000, outputTokens: 200, totalCostUsd: 0.05 }),
        msgWithUsage("b", { inputTokens: 500, outputTokens: 500, totalCostUsd: 0.07 }),
      ],
    }
    render(<SessionCostBadgeLive sessionId="s1" tokensLabel={tokens} />)
    // 1500 in / 700 out, 0.12 cost.
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("Tokens 1.5k/700")
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("$0.1200")
  })
})

describe("aggregateUsage", () => {
  it("returns null when no usage anywhere", () => {
    expect(
      aggregateUsage([{ id: "x", role: "user", parts: [] } as unknown as UIMessage])
    ).toBeNull()
  })

  it("sums every usage field across messages", () => {
    const out = aggregateUsage([
      msgWithUsage("a", {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
        totalCostUsd: 1,
      }),
      msgWithUsage("b", { inputTokens: 5, totalCostUsd: 2 }),
    ])
    expect(out).toEqual({
      inputTokens: 15,
      outputTokens: 20,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      totalCostUsd: 3,
    })
  })
})
