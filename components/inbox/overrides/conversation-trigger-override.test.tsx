import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

import { resolveBinding } from "@/lib/connectors/policy-resolve"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy, type TriggerPolicy } from "@/types/connectors/policy"

import {
  ConversationTriggerOverride,
  mergeConversationTrigger,
} from "./conversation-trigger-override"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const BASELINE = defaultGroupChatPolicy()

function Harness({
  initial,
  onValue,
}: {
  initial?: Partial<TriggerPolicy>
  onValue?: (next: Partial<TriggerPolicy> | undefined) => void
}) {
  const [value, setValue] = useState<Partial<TriggerPolicy> | undefined>(initial)
  return (
    <ConversationTriggerOverride
      baseline={BASELINE}
      value={value}
      onChange={(next) => {
        setValue(next)
        onValue?.(next)
      }}
    />
  )
}

it("shows nothing to edit while the chat inherits everything", () => {
  render(<Harness />)
  expect(screen.getByTestId("conv-trigger-override-rules-switch")).not.toBeChecked()
  expect(screen.queryByTestId("conv-trigger-policy-editor")).not.toBeInTheDocument()
})

// Seeding from the effective policy is the whole safety property: an empty
// policy saved by accident silences the chat.
it("seeds a newly taken-over part from what the chat already evaluates", async () => {
  const user = userEvent.setup()
  const seen: Array<Partial<TriggerPolicy> | undefined> = []
  render(<Harness onValue={(v) => seen.push(v)} />)

  await user.click(screen.getByTestId("conv-trigger-override-rules-switch"))

  expect(seen.at(-1)).toEqual({ rules: BASELINE.rules })
  expect(screen.getByTestId("conv-trigger-rule-self-mention-switch")).toBeChecked()
})

it("takes over only the part that was switched on", async () => {
  const user = userEvent.setup()
  const seen: Array<Partial<TriggerPolicy> | undefined> = []
  render(<Harness onValue={(v) => seen.push(v)} />)

  await user.click(screen.getByTestId("conv-trigger-override-blockers-switch"))

  expect(seen.at(-1)).toEqual({ blockers: BASELINE.blockers })
  // The conditions stay the bot's, so their controls are not on this screen.
  expect(screen.queryByTestId("conv-trigger-rule-self-mention")).not.toBeInTheDocument()
  expect(screen.getByTestId("conv-trigger-blocker-rate-limit")).toBeInTheDocument()
})

it("clears the override entirely when the last part goes back to inherit", async () => {
  const user = userEvent.setup()
  const seen: Array<Partial<TriggerPolicy> | undefined> = []
  render(<Harness initial={{ rules: BASELINE.rules }} onValue={(v) => seen.push(v)} />)

  await user.click(screen.getByTestId("conv-trigger-override-rules-switch"))

  // `{}` would leave the row claiming a customisation it does not have —
  // `resolveBinding` reads an empty object as no override either way.
  expect(seen.at(-1)).toBeUndefined()
})

it("reports an edit as the overridden part only", async () => {
  const user = userEvent.setup()
  const seen: Array<Partial<TriggerPolicy> | undefined> = []
  render(<Harness initial={{ blockers: [] }} onValue={(v) => seen.push(v)} />)

  await user.click(screen.getByTestId("conv-trigger-blocker-cooldown-switch"))

  expect(seen.at(-1)).toEqual({ blockers: [{ kind: "cooldown-after-bot-reply", secs: 3 }] })
  expect(seen.at(-1)).not.toHaveProperty("rules")
})

it("keeps the three parts independent", async () => {
  const user = userEvent.setup()
  const seen: Array<Partial<TriggerPolicy> | undefined> = []
  render(<Harness onValue={(v) => seen.push(v)} />)

  await user.click(screen.getByTestId("conv-trigger-override-rules-switch"))
  await user.click(screen.getByTestId("conv-trigger-override-storeUnmatched-switch"))

  expect(seen.at(-1)).toEqual({
    rules: BASELINE.rules,
    storeUnmatchedInDraftMode: BASELINE.storeUnmatchedInDraftMode,
  })
  expect(seen.at(-1)).not.toHaveProperty("blockers")
})

describe("mergeConversationTrigger", () => {
  /**
   * The merge shown in the editor has to be the merge the bus performs, or the
   * screen describes a policy the conversation does not actually run.
   */
  it.each([
    ["nothing overridden", undefined],
    ["rules only", { rules: [{ kind: "private-default" } as const] }],
    ["blockers only", { blockers: [] }],
    ["store-unmatched only", { storeUnmatchedInDraftMode: true }],
    ["everything", { rules: [], blockers: [], storeUnmatchedInDraftMode: true }],
  ])("agrees with resolveBinding for %s", (_name, trigger) => {
    const resolved = resolveBinding({
      adapter: {
        trigger: BASELINE,
        defaultMode: "auto",
        defaultCharacterId: undefined,
      } as Pick<AdapterInstanceRow, "trigger" | "defaultMode" | "defaultCharacterId">,
      character: null,
      override: { trigger } as Pick<
        ConversationOverrideRow,
        "mode" | "characterId" | "characterDisabled" | "trigger"
      >,
    })
    expect(mergeConversationTrigger(BASELINE, trigger)).toEqual(resolved.trigger)
  })
})
