/** @jest-environment jsdom */
/**
 * Unit tests for `resolveRespondViaTarget` (lib/connectors/runtime.ts) —
 * multi-bot cross-account send. Deliberately a separate, light suite: the
 * main runtime.test.ts stands up the full installRuntime harness whose
 * ai-run turns leak trailing async work across test boundaries; these unit
 * tests only need Dexie + the resolver itself.
 *
 * Covers: no-op fallbacks (unset / self), the valid-sibling rewrite
 * (adapterId + conversationKey + conversationRef + applied audit), and each
 * invalid-target reason (not_found / disabled / muted / cross_platform).
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { resolveRespondViaTarget } from "./runtime"

/** Put an adapterInstances row with an explicit id. */
async function putInstance(id: string, patch: Partial<AdapterInstanceRow> = {}): Promise<void> {
  await getDb().adapterInstances.put({
    id,
    type: "telegram",
    displayName: `Instance ${id}`,
    enabled: true,
    transportMode: "long-poll",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as AdapterInstanceRow)
}

const EVENT = {
  adapterId: "adapter_1",
  conversationKey: "telegram:adapter_1:chat_42",
  conversationRef: { platform: "telegram", adapterId: "adapter_1" },
} as Pick<NormalizedInboundEvent, "adapterId" | "conversationKey" | "conversationRef">
const ROW = { type: "telegram" } as AdapterInstanceRow

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("resolveRespondViaTarget", () => {
  // 30 s timeout: the first cold Dexie open in this suite regularly exceeds
  // jest's 5 s default (schema v101) — same convention as the other suites.
  it("rewrites adapterId + conversationKey + conversationRef for a valid sibling", async () => {
    await putInstance("adapter_2")
    const target = await resolveRespondViaTarget("adapter_2", EVENT, ROW)
    expect(target).toEqual({
      adapterId: "adapter_2",
      conversationKey: "telegram:adapter_2:chat_42",
      conversationRef: { platform: "telegram", adapterId: "adapter_2" },
    })
    const audits = await getDb().connectorAudit.toArray()
    const decision = audits.find((a) => a.kind === "dispatch.respond_via")
    expect(decision).toBeDefined()
    expect(decision!.fields).toMatchObject({ targetAdapterId: "adapter_2", applied: true })
  }, 30_000)

  it("returns the receiving bot unchanged when unset or self", async () => {
    expect(await resolveRespondViaTarget(undefined, EVENT, ROW)).toMatchObject({
      adapterId: "adapter_1",
      conversationKey: "telegram:adapter_1:chat_42",
    })
    expect(await resolveRespondViaTarget("adapter_1", EVENT, ROW)).toMatchObject({
      adapterId: "adapter_1",
    })
    // No audit row for the no-op path.
    expect(await getDb().connectorAudit.count()).toBe(0)
  })

  it.each([
    ["not_found", async (): Promise<void> => undefined],
    ["disabled", async (): Promise<void> => putInstance("adapter_2", { enabled: false })],
    ["muted", async (): Promise<void> => putInstance("adapter_2", { muted: true })],
    [
      "cross_platform",
      async (): Promise<void> => putInstance("adapter_2", { type: "discord" } as never),
    ],
  ] as const)(
    "falls back to the receiving bot and audits reason=%s",
    async (reason, seed) => {
      await seed()
      const target = await resolveRespondViaTarget("adapter_2", EVENT, ROW)
      expect(target.adapterId).toBe("adapter_1")
      expect(target.conversationKey).toBe("telegram:adapter_1:chat_42")
      const audits = await getDb().connectorAudit.toArray()
      const decision = audits.find((a) => a.kind === "dispatch.respond_via")
      expect(decision!.fields).toMatchObject({ applied: false, reason })
    },
    30_000
  )
})
