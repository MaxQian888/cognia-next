import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

import {
  emptyTriggerPolicyDraft,
  fromTriggerPolicyDraft,
  toTriggerPolicyDraft,
  type TriggerPolicyDraft,
} from "@/lib/connectors/trigger-policy-draft"
import { defaultGroupChatPolicy, type TriggerPolicy } from "@/types/connectors/policy"

import { TriggerPolicyEditor } from "./trigger-policy-editor"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    return t
  },
}))

/** Drives the editor the way its real parents do, so edits actually land. */
function Harness({
  initial,
  onPolicy,
}: {
  initial: TriggerPolicyDraft
  onPolicy?: (policy: TriggerPolicy) => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <TriggerPolicyEditor
      value={draft}
      onChange={(next) => {
        setDraft(next)
        onPolicy?.(fromTriggerPolicyDraft(next))
      }}
    />
  )
}

it("renders a slot for all seven conditions and all five blockers", () => {
  render(<Harness initial={toTriggerPolicyDraft(defaultGroupChatPolicy())} />)
  for (const id of [
    "trigger-rule-private-default",
    "trigger-rule-self-mention",
    "trigger-rule-reply-to-bot",
    "trigger-rule-slash-command",
    "trigger-rule-keyword",
    "trigger-rule-user-allowlist",
    "trigger-rule-channel-allowlist",
    "trigger-blocker-user-blocklist",
    "trigger-blocker-channel-blocklist",
    "trigger-blocker-keyword-blocklist",
    "trigger-blocker-rate-limit",
    "trigger-blocker-cooldown",
  ]) {
    expect(screen.getByTestId(id)).toBeInTheDocument()
  }
})

it("shows a stored policy as switched-on slots with their values", () => {
  render(<Harness initial={toTriggerPolicyDraft(defaultGroupChatPolicy())} />)
  expect(screen.getByTestId("trigger-rule-self-mention-switch")).toBeChecked()
  expect(screen.getByTestId("trigger-rule-keyword-switch")).not.toBeChecked()
  expect(screen.getByTestId("trigger-rate-user")).toHaveValue(5)
  expect(screen.getByTestId("trigger-cooldown-secs")).toHaveValue(3)
})

// Parameters under a switched-off condition read as active configuration and
// are not, so they stay hidden until the condition is on.
it("hides a condition's parameters until it is switched on", async () => {
  const user = userEvent.setup()
  render(<Harness initial={emptyTriggerPolicyDraft()} />)

  expect(screen.queryByLabelText("rules.keyword.listAria")).not.toBeInTheDocument()
  await user.click(screen.getByTestId("trigger-rule-keyword-switch"))
  expect(screen.getByLabelText("rules.keyword.listAria")).toBeInTheDocument()
})

it("turns an edited slot into the rule the evaluator reads", async () => {
  const user = userEvent.setup()
  const seen: TriggerPolicy[] = []
  render(<Harness initial={emptyTriggerPolicyDraft()} onPolicy={(p) => seen.push(p)} />)

  await user.click(screen.getByTestId("trigger-rule-keyword-switch"))
  await user.type(screen.getByLabelText("rules.keyword.listAria"), "deploy{Enter}")

  expect(seen.at(-1)?.rules).toEqual([
    { kind: "keyword", words: ["deploy"], caseInsensitive: true },
  ])
})

it("keeps an unset workspace ceiling out of the saved blocker", async () => {
  const user = userEvent.setup()
  const seen: TriggerPolicy[] = []
  render(<Harness initial={emptyTriggerPolicyDraft()} onPolicy={(p) => seen.push(p)} />)

  await user.click(screen.getByTestId("trigger-blocker-rate-limit-switch"))
  expect(seen.at(-1)?.blockers[0]).not.toHaveProperty("perTenantPerMin")

  await user.type(screen.getByTestId("trigger-rate-tenant"), "90")
  expect(seen.at(-1)?.blockers[0]).toHaveProperty("perTenantPerMin", 90)
})

describe("diagnostics", () => {
  it("says so when nothing is on, and does not also list the two narrower gaps", () => {
    render(<Harness initial={emptyTriggerPolicyDraft()} />)
    expect(screen.getByTestId("trigger-gap-no-rules")).toBeInTheDocument()
    expect(screen.queryByTestId("trigger-gap-plain-private")).not.toBeInTheDocument()
  })

  it("names the chat scope a policy cannot answer in", () => {
    render(
      <Harness
        initial={toTriggerPolicyDraft({
          rules: [{ kind: "private-default" }],
          blockers: [],
          storeUnmatchedInDraftMode: false,
        })}
      />
    )
    expect(screen.getByTestId("trigger-gap-group-mention")).toBeInTheDocument()
    expect(screen.queryByTestId("trigger-gap-plain-private")).not.toBeInTheDocument()
  })

  it("stays quiet about a policy that covers both scopes", () => {
    render(<Harness initial={toTriggerPolicyDraft(defaultGroupChatPolicy())} />)
    expect(screen.queryByTestId("trigger-coverage-gaps")).not.toBeInTheDocument()
  })

  it("flags a switched-on condition that has nothing to match", async () => {
    const user = userEvent.setup()
    render(<Harness initial={emptyTriggerPolicyDraft()} />)

    await user.click(screen.getByTestId("trigger-rule-slash-command-switch"))
    expect(screen.getByTestId("trigger-warning-slash-command-empty")).toBeInTheDocument()

    await user.type(screen.getByLabelText("rules.slashCommand.listAria"), "/ask{Enter}")
    expect(screen.queryByTestId("trigger-warning-slash-command-empty")).not.toBeInTheDocument()
  })

  it("flags a rate limit that would silence the bot entirely", async () => {
    const user = userEvent.setup()
    render(<Harness initial={emptyTriggerPolicyDraft()} />)

    await user.click(screen.getByTestId("trigger-blocker-rate-limit-switch"))
    await user.clear(screen.getByTestId("trigger-rate-user"))
    await user.type(screen.getByTestId("trigger-rate-user"), "0")

    expect(screen.getByTestId("trigger-warning-rate-limit-blocks-everything")).toBeInTheDocument()
  })

  // `Number("")` is `0` and finite, so an emptied box used to COMMIT 0 — and a
  // 0 is not a small limit, it is a bot that answers nobody (the evaluator
  // blocks at `recent.length >= limit`). The box must be allowed to go empty
  // without the model taking a value the operator never typed.
  it("does not commit a rate limit of 0 when the box is merely cleared", async () => {
    const user = userEvent.setup()
    const onPolicy = jest.fn()
    render(<Harness initial={emptyTriggerPolicyDraft()} onPolicy={onPolicy} />)

    await user.click(screen.getByTestId("trigger-blocker-rate-limit-switch"))
    onPolicy.mockClear()
    const field = screen.getByTestId("trigger-rate-user") as HTMLInputElement
    await user.clear(field)

    // The box shows empty — the operator is mid-edit, not done.
    expect(field.value).toBe("")
    // ...but nothing committed a 0, so no policy claims to block everything.
    expect(screen.queryByTestId("trigger-warning-rate-limit-blocks-everything")).toBeNull()
    for (const [policy] of onPolicy.mock.calls as [TriggerPolicy][]) {
      const limit = policy.blockers.find((b) => b.kind === "rate-limit")
      if (limit && limit.kind === "rate-limit") expect(limit.perUserPerMin).toBeGreaterThan(0)
    }
  })

  it("restores the last committed value when a cleared box loses focus", async () => {
    const user = userEvent.setup()
    render(<Harness initial={emptyTriggerPolicyDraft()} />)

    await user.click(screen.getByTestId("trigger-blocker-rate-limit-switch"))
    const field = screen.getByTestId("trigger-rate-user") as HTMLInputElement
    const committed = field.value
    await user.clear(field)
    await user.tab()

    expect(field.value).toBe(committed)
  })

  it("still lets the operator clear and retype a whole new value", async () => {
    const user = userEvent.setup()
    const onPolicy = jest.fn()
    render(<Harness initial={emptyTriggerPolicyDraft()} onPolicy={onPolicy} />)

    await user.click(screen.getByTestId("trigger-blocker-rate-limit-switch"))
    const field = screen.getByTestId("trigger-rate-user") as HTMLInputElement
    await user.clear(field)
    await user.type(field, "42")

    expect(field.value).toBe("42")
    const last = onPolicy.mock.calls.at(-1)?.[0] as TriggerPolicy
    const limit = last.blockers.find((b) => b.kind === "rate-limit")
    expect(limit && limit.kind === "rate-limit" && limit.perUserPerMin).toBe(42)
  })

  // The one policy shape the per-kind slots cannot hold. It is still evaluated
  // by the bus, so hiding it would be a lie about what the bot does.
  it("reports a rule the slots cannot show, instead of dropping it", () => {
    render(
      <Harness
        initial={toTriggerPolicyDraft({
          rules: [
            { kind: "keyword", words: ["deploy"], caseInsensitive: true },
            { kind: "keyword", words: ["SHIP"], caseInsensitive: false },
          ],
          blockers: [],
          storeUnmatchedInDraftMode: false,
        })}
      />
    )
    expect(screen.getByTestId("trigger-residual")).toBeInTheDocument()
  })

  it("carries that rule through an unrelated edit", async () => {
    const user = userEvent.setup()
    const seen: TriggerPolicy[] = []
    render(
      <Harness
        initial={toTriggerPolicyDraft({
          rules: [
            { kind: "keyword", words: ["deploy"], caseInsensitive: true },
            { kind: "keyword", words: ["SHIP"], caseInsensitive: false },
          ],
          blockers: [],
          storeUnmatchedInDraftMode: false,
        })}
        onPolicy={(p) => seen.push(p)}
      />
    )

    await user.click(screen.getByTestId("trigger-rule-private-default-switch"))
    expect(seen.at(-1)?.rules).toContainEqual({
      kind: "keyword",
      words: ["SHIP"],
      caseInsensitive: false,
    })
  })
})
