import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createLoop } from "@/lib/db/loops"
import { useOpenLoop } from "./use-active-loop"

const BASE = {
  mode: "self_paced" as const,
  rawPrompt: "p",
  safePrompt: "p",
  redactionMapEnc: "",
  isSlashCommand: false,
  iterations: 0,
  tokensUsed: 0,
  generationId: "g",
  config: {
    maxIterations: 100,
    maxTokens: 1_000_000,
    minDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxParseFailures: 3,
  },
  parseFailureCount: 0,
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useOpenLoop", () => {
  it("returns null for a missing session id", async () => {
    const { result } = renderHook(() => useOpenLoop(null))
    await waitFor(() => expect(result.current).toBeNull())
  })

  it("live-queries the open loop for the session", async () => {
    await createLoop({ ...BASE, id: "lp_1", sessionId: "ses_a", status: "active" })
    const { result } = renderHook(() => useOpenLoop("ses_a"))
    await waitFor(() => expect(result.current?.id).toBe("lp_1"))
  })

  it("returns null when only terminal loops exist", async () => {
    await createLoop({ ...BASE, id: "lp_done", sessionId: "ses_a", status: "completed" })
    const { result } = renderHook(() => useOpenLoop("ses_a"))
    await waitFor(() => expect(result.current).toBeNull())
  })
})
