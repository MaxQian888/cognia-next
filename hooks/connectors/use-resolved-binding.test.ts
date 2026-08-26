/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultTriggerPolicyFor } from "@/types/connectors/policy"

import { useResolvedBinding } from "./use-resolved-binding"

const CONVERSATION_KEY = "telegram:cai_1:chat_1"

function makeAdapter(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "cai_1",
    type: "telegram",
    displayName: "Bot",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "cognia", accounts: [] },
    trigger: defaultTriggerPolicyFor("telegram"),
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const binding = { adapterId: "cai_1", conversationKey: CONVERSATION_KEY }

beforeEach(async () => {
  __resetDbForTesting()
  await getDb().adapterInstances.clear()
  await getDb().conversationOverrides.clear()
  await getDb().characters.clear()
})

it("returns null without a binding", async () => {
  const { result } = renderHook(() => useResolvedBinding(null))
  await waitFor(() => expect(result.current).toBeNull())
})

// A binding resolved without its adapter row would be a fabricated answer, not
// a partial one — every layer above it is a modifier on the adapter's policy.
it("returns null while the adapter row is missing", async () => {
  const { result } = renderHook(() => useResolvedBinding(binding))
  await waitFor(() => expect(result.current).toBeNull())
})

it("resolves the adapter's own policy when nothing overrides it", async () => {
  await getDb().adapterInstances.add(makeAdapter())
  const { result } = renderHook(() => useResolvedBinding(binding))
  await waitFor(() => {
    expect(result.current?.trigger).toEqual(defaultTriggerPolicyFor("telegram"))
    expect(result.current?.modeSource).toBe("adapter-default")
  })
})

it("applies a conversation trigger override on top", async () => {
  await getDb().adapterInstances.add(makeAdapter())
  await getDb().conversationOverrides.add({
    id: "cov_1",
    conversationKey: CONVERSATION_KEY,
    sessionId: "s1",
    trigger: { blockers: [{ kind: "cooldown-after-bot-reply", secs: 42 }] },
    createdAt: 0,
    updatedAt: 0,
  })
  const { result } = renderHook(() => useResolvedBinding(binding))
  await waitFor(() => {
    expect(result.current?.trigger.blockers).toEqual([
      { kind: "cooldown-after-bot-reply", secs: 42 },
    ])
    // The part the chat did NOT take over still follows the bot.
    expect(result.current?.trigger.rules).toEqual(defaultTriggerPolicyFor("telegram").rules)
  })
})

// The read-outs that use this sit next to the controls that change it, so a
// value captured at mount would describe the bot as it was before the edit.
it("tracks a later edit without remounting", async () => {
  await getDb().adapterInstances.add(makeAdapter({ defaultMode: "auto" }))
  const { result } = renderHook(() => useResolvedBinding(binding))
  await waitFor(() => expect(result.current?.mode).toBe("auto"))

  await getDb().conversationOverrides.add({
    id: "cov_2",
    conversationKey: CONVERSATION_KEY,
    sessionId: "s1",
    mode: "manual",
    createdAt: 0,
    updatedAt: 0,
  })
  await waitFor(() => expect(result.current?.mode).toBe("manual"))
})

it("drops the character layer when the conversation disabled it", async () => {
  await getDb().adapterInstances.add(makeAdapter({ defaultCharacterId: "char_1" }))
  await getDb().characters.add({
    id: "char_1",
    name: "Persona",
    platformDefaults: { mode: "draft" },
  } as never)
  const withCharacter = renderHook(() => useResolvedBinding(binding))
  await waitFor(() => expect(withCharacter.result.current?.modeSource).toBe("character-default"))

  await getDb().conversationOverrides.add({
    id: "cov_3",
    conversationKey: CONVERSATION_KEY,
    sessionId: "s1",
    characterDisabled: true,
    createdAt: 0,
    updatedAt: 0,
  })
  await waitFor(() => expect(withCharacter.result.current?.modeSource).toBe("adapter-default"))
})
