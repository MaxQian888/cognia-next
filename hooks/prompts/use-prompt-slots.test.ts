/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { publishPromptBody, savePromptDraft } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { usePromptSlot, usePromptSlots } from "./use-prompt-slots"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)

const account = { scope: "account" as const, targetId: "" }

it("follows a slot's published revision, draft and history live", async () => {
  const { result } = renderHook(() => usePromptSlot(BRIEF_MODE_PROMPT.id, account))
  await waitFor(() => expect(result.current).toEqual({ slot: {}, revisions: [] }))

  await act(async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "One.",
      expectedRev: 0,
    })
  })
  await waitFor(() => expect(result.current?.slot.active?.body).toBe("One."))

  await act(async () => {
    await savePromptDraft({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Two (draft).",
      expectedRev: result.current!.slot.binding!.rev,
    })
  })
  await waitFor(() => expect(result.current?.slot.draft?.body).toBe("Two (draft)."))
  expect(result.current?.revisions.map((revision) => revision.kind)).toEqual(["draft", "published"])
})

it("lists every scope holding a binding", async () => {
  const { result } = renderHook(() => usePromptSlots(BRIEF_MODE_PROMPT.id))
  await waitFor(() => expect(result.current).toEqual([]))
  await act(async () => {
    await publishPromptBody({ def: BRIEF_MODE_PROMPT, target: account, body: "A.", expectedRev: 0 })
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: { scope: "workspace", targetId: "ws-1" },
      body: "W.",
      expectedRev: 0,
    })
  })
  await waitFor(() => expect(result.current).toHaveLength(2))
  expect(result.current?.map((slot) => slot.binding?.scope).sort()).toEqual([
    "account",
    "workspace",
  ])
})
