/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

interface Summary {
  pending: number
  sending: number
  deadlettered: number
  rejected: number
  conflicted: number
}
const EMPTY: Summary = { pending: 0, sending: 0, deadlettered: 0, rejected: 0, conflicted: 0 }
let mockSummary: Summary = EMPTY
let mockConsent: string | null = null

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
// The live query's subscription is Dexie's business; here it resolves the
// query once, which is all the hook's arithmetic needs.
jest.mock("@/hooks/data", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factory is hoisted above imports, so React must be required inside it.
  const React = require("react") as typeof import("react")
  return {
    useClientLiveQuery: <T,>(query: () => Promise<T>, _deps: unknown[], initial: T) => {
      const [value, setValue] = React.useState<T>(initial)
      const queryRef = React.useRef(query)
      React.useEffect(() => {
        void queryRef.current().then(setValue)
      }, [])
      return value
    },
  }
})
// `inFlight` / `needsAttention` reproduce the real classifiers rather than
// stubbing them, so the hook's split is exercised against the real meaning.
jest.mock("@/lib/queue/outbound-queue", () => ({
  getQueueSummary: async () => mockSummary,
  inFlight: (s: Summary) => s.pending + s.sending,
  needsAttention: (s: Summary) => s.deadlettered + s.rejected + s.conflicted,
}))
jest.mock("@/lib/queue/outbound-approval", () => ({
  PENDING_NO_CODE: "__no_code__",
  outboundConsentCode: () => mockConsent,
  subscribeOutboundApproval: () => () => {},
}))

import { useOutboundQueueStatus } from "./use-outbound-queue-status"

afterEach(() => {
  mockSummary = EMPTY
  mockConsent = null
})

describe("useOutboundQueueStatus", () => {
  it("reports nothing for an empty queue", async () => {
    const { result } = renderHook(() => useOutboundQueueStatus())
    await waitFor(() => expect(result.current.visible).toBe(false))
    expect(result.current.message).toBe("")
    expect(result.current.hasRows).toBe(false)
  })

  it("counts queued rows", async () => {
    mockSummary = { ...EMPTY, pending: 3 }
    const { result } = renderHook(() => useOutboundQueueStatus())
    await waitFor(() => expect(result.current.pending).toBe(3))
    expect(result.current.visible).toBe(true)
    expect(result.current.hasRows).toBe(true)
    expect(result.current.message).toBe('queuePending:{"count":3}')
  })

  it("names the rows on the wire inside the queued count", async () => {
    mockSummary = { ...EMPTY, pending: 1, sending: 1 }
    const { result } = renderHook(() => useOutboundQueueStatus())
    await waitFor(() => expect(result.current.sending).toBe(1))
    expect(result.current.message).toBe('queuePendingWithSending:{"count":2,"sending":1}')
  })

  it("prefers the rows that stopped over the in-flight count", async () => {
    mockSummary = { ...EMPTY, pending: 2, rejected: 1 }
    const { result } = renderHook(() => useOutboundQueueStatus())
    await waitFor(() => expect(result.current.stuck).toBe(1))
    expect(result.current.message).toBe('queueNeedsAttention:{"count":1}')
  })

  it("reports an approval wait even with nothing counted", async () => {
    mockConsent = "4821"
    const { result } = renderHook(() => useOutboundQueueStatus())
    await waitFor(() => expect(result.current.visible).toBe(true))
    expect(result.current.awaitingApproval).toBe(true)
    expect(result.current.hasRows).toBe(false)
    expect(result.current.message).toBe('queueAwaitingApproval:{"code":"4821"}')
  })

  it("words an approval wait the Host gave no code for", async () => {
    mockConsent = "__no_code__"
    const { result } = renderHook(() => useOutboundQueueStatus())
    await waitFor(() => expect(result.current.message).toBe("queueAwaitingApprovalNoCode"))
  })
})
