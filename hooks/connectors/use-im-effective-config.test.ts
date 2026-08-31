/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import { defaultTriggerPolicyFor } from "@/types/connectors/policy"

import { useImEffectiveConfig } from "./use-im-effective-config"

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

function makeOverride(patch: Partial<ConversationOverrideRow> = {}): ConversationOverrideRow {
  return {
    id: "cov_1",
    conversationKey: CONVERSATION_KEY,
    updatedAt: 0,
    ...patch,
  } as ConversationOverrideRow
}

beforeEach(async () => {
  __resetDbForTesting()
  await getDb().adapterInstances.clear()
})

it("returns undefined without an adapter id", async () => {
  const { result } = renderHook(() =>
    useImEffectiveConfig({ adapterId: undefined, override: null })
  )
  await waitFor(() => expect(result.current).toBeUndefined())
})

// A config resolved without its adapter row would be a fabricated answer, not
// a partial one: every layer above it is a modifier on the adapter's defaults.
it("returns undefined while the adapter row is missing", async () => {
  const { result } = renderHook(() => useImEffectiveConfig({ adapterId: "cai_1", override: null }))
  await waitFor(() => expect(result.current).toBeUndefined())
})

it("resolves the adapter defaults when the conversation pinned nothing", async () => {
  await getDb().adapterInstances.add(makeAdapter())
  const { result } = renderHook(() => useImEffectiveConfig({ adapterId: "cai_1", override: null }))
  await waitFor(() => {
    expect(result.current?.autonomy.effective).toBe("act")
    expect(result.current?.engagement.effective).toBe("inline")
    expect(result.current?.target.effective.kind).toBe("direct")
  })
})

// An absent override row must not read as "still loading": a conversation that
// never pinned anything is the common case, and blanking the chip for it would
// hide the bot's actual behaviour on most conversations.
it("treats an undefined override the same as none", async () => {
  await getDb().adapterInstances.add(makeAdapter())
  const { result } = renderHook(() =>
    useImEffectiveConfig({ adapterId: "cai_1", override: undefined })
  )
  await waitFor(() => expect(result.current?.autonomy.effective).toBe("act"))
})

it("prefers the conversation's own axes over the bot defaults", async () => {
  await getDb().adapterInstances.add(makeAdapter({ defaultAutonomy: "act" }))
  const { result } = renderHook(() =>
    useImEffectiveConfig({
      adapterId: "cai_1",
      override: makeOverride({ autonomy: "suggest" }),
    })
  )
  await waitFor(() => {
    expect(result.current?.autonomy.effective).toBe("suggest")
    expect(result.current?.autonomy.source).toBe("conversation-override")
  })
})

// The target is what makes `delegate` selectable, so the chip has to read it
// from here rather than assuming `direct`.
it("reports a bound team as the effective target", async () => {
  await getDb().adapterInstances.add(makeAdapter())
  const { result } = renderHook(() =>
    useImEffectiveConfig({ adapterId: "cai_1", override: makeOverride({ teamId: "team_1" }) })
  )
  await waitFor(() => {
    expect(result.current?.target.effective).toEqual({ kind: "team", id: "team_1" })
    expect(result.current?.engagement.effective).toBe("background")
  })
})

// An SLA step forcing the mode has to stay labelled, because that label is what
// the chip uses to say the operator did not choose this.
it("labels an escalation-forced mode as such", async () => {
  await getDb().adapterInstances.add(makeAdapter())
  const { result } = renderHook(() =>
    useImEffectiveConfig({
      adapterId: "cai_1",
      override: makeOverride({ mode: "draft", modeForcedBy: "escalation" }),
    })
  )
  await waitFor(() => expect(result.current?.mode.source).toBe("escalation"))
})
