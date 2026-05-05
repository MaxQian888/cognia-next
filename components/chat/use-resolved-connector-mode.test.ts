/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { useResolvedConnectorMode } from "./use-resolved-connector-mode"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// ── Minimal adapter row helper ────────────────────────────────────────────────

function makeAdapter(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "cai_test_1",
    type: "telegram",
    displayName: "Test Telegram",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "cognia", accounts: ["botToken"] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
    defaultMode: "auto",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ── Minimal ChatSession helper ────────────────────────────────────────────────

function makeSession(
  overrides: Partial<ChatSession> & {
    adapterId?: string
    conversationKey?: string
    mode?: "auto" | "manual" | "draft"
  }
): ChatSession {
  const {
    adapterId = "cai_test_1",
    conversationKey = "telegram:cai_test_1:chat_1",
    mode: _mode,
    ...rest
  } = overrides
  return {
    id: "sess_1",
    title: "Test",
    kind: "direct",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    platformBinding: {
      platform: "telegram",
      adapterId,
      conversationKey,
      conversationRef: { platform: "telegram", adapterId },
    },
    ...rest,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  __resetDbForTesting()
  await getDb().adapterInstances.clear()
  await getDb().conversationOverrides.clear()
  await getDb().characters.clear()
})

describe("useResolvedConnectorMode", () => {
  it("returns null for a session without platformBinding", async () => {
    const session: ChatSession = {
      id: "sess_plain",
      title: "Plain",
      kind: "direct",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const { result } = renderHook(() => useResolvedConnectorMode(session))
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("returns null for null session", async () => {
    const { result } = renderHook(() => useResolvedConnectorMode(null))
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("returns adapter defaultMode when no override exists (auto)", async () => {
    await getDb().adapterInstances.add(makeAdapter({ defaultMode: "auto" }))
    const session = makeSession({})
    const { result } = renderHook(() => useResolvedConnectorMode(session))
    await waitFor(() => {
      expect(result.current).toBe("auto")
    })
  })

  it("returns 'manual' when adapter defaultMode is manual", async () => {
    await getDb().adapterInstances.add(makeAdapter({ defaultMode: "manual" }))
    const session = makeSession({})
    const { result } = renderHook(() => useResolvedConnectorMode(session))
    await waitFor(() => {
      expect(result.current).toBe("manual")
    })
  })

  it("returns 'draft' when adapter defaultMode is draft", async () => {
    await getDb().adapterInstances.add(makeAdapter({ defaultMode: "draft" }))
    const session = makeSession({})
    const { result } = renderHook(() => useResolvedConnectorMode(session))
    await waitFor(() => {
      expect(result.current).toBe("draft")
    })
  })

  it("conversation override mode takes precedence over adapter defaultMode", async () => {
    await getDb().adapterInstances.add(makeAdapter({ defaultMode: "auto" }))
    // Insert a conversation override for "manual"
    const now = Date.now()
    await getDb().conversationOverrides.add({
      id: "cov_1",
      conversationKey: "telegram:cai_test_1:chat_1",
      sessionId: "sess_1",
      mode: "manual",
      createdAt: now,
      updatedAt: now,
    })
    const session = makeSession({})
    const { result } = renderHook(() => useResolvedConnectorMode(session))
    await waitFor(() => {
      expect(result.current).toBe("manual")
    })
  })

  it("returns null when adapter row is missing", async () => {
    // No adapter inserted — should resolve to null
    const session = makeSession({ adapterId: "nonexistent_adapter" })
    const { result } = renderHook(() => useResolvedConnectorMode(session))
    await waitFor(() => {
      // Should end up null since adapter not found
      expect(result.current).toBeNull()
    })
  })
})
