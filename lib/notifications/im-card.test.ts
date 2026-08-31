import { buildNotificationCardSurface, DEFAULT_NOTIFICATION_CARD_LABELS } from "./im-card"
import type { NotificationRecord } from "@/types/notifications"

type Input = Parameters<typeof buildNotificationCardSurface>[0]["record"]

function rec(over: Partial<NotificationRecord> = {}): Input {
  return {
    id: "n1",
    title: "Plan awaiting approval: Ship it",
    body: "3 step(s) - chat",
    actions: [
      { id: "approve", label: "Approve", command: "plan.approval.respond", variant: "primary" },
      { id: "reject", label: "Discard", command: "plan.approval.respond", variant: "secondary" },
    ],
    ...over,
  } as Input
}

const components = (r: Input) =>
  buildNotificationCardSurface({ record: r }).components as Record<string, Record<string, unknown>>

const mirror = (r: Input) =>
  (buildNotificationCardSurface({ record: r }).widget as { fallbackText: string }).fallbackText

it("renders one Button per action, keyed by the action id", () => {
  const c = components(rec())
  expect(c.action_approve.component).toBe("Button")
  expect(c.action_approve.text).toBe("Approve")
  expect(c.action_reject.text).toBe("Discard")
  expect(c.actions.children).toEqual(["action_approve", "action_reject"])
})

// Keyed by id rather than index so a card re-rendered after one action was
// removed does not re-point the remaining buttons at different work.
it("keeps a button's key stable when an earlier action disappears", () => {
  const full = components(rec())
  const trimmed = components(rec({ actions: [rec().actions![1]] } as Partial<NotificationRecord>))
  expect(Object.keys(trimmed)).toContain("action_reject")
  expect(trimmed.action_reject.text).toBe(full.action_reject.text)
})

// The command lives on the persisted centre row. Baking it into the button
// would let a card pressed days later run work the record no longer offers.
it("carries only the two ids in the binding payload", () => {
  const button = components(rec()).action_approve
  expect(button.bindingKind).toBe("notification_action")
  expect(button.bindingPayload).toEqual({ notificationId: "n1", actionId: "approve" })
  expect(JSON.stringify(button)).not.toContain("plan.approval.respond")
})

// Slack allows one primary button per block and reserves danger for
// destructive work, so only the author's explicit `primary` is carried over.
it("carries only an explicit primary variant", () => {
  const c = components(rec())
  expect(c.action_approve.variant).toBe("primary")
  expect(c.action_reject.variant).toBeUndefined()
})

it("numbers the actions in the mirror for adapters with no buttons", () => {
  const text = mirror(rec())
  expect(text).toContain(DEFAULT_NOTIFICATION_CARD_LABELS.replyHint)
  expect(text).toContain("1. Approve")
  expect(text).toContain("2. Discard")
  // The hint has to precede the options it explains.
  expect(text.indexOf(DEFAULT_NOTIFICATION_CARD_LABELS.replyHint)).toBeLessThan(
    text.indexOf("1. Approve")
  )
})

// The deep link is the only affordance left on a platform that renders neither
// buttons nor a numbered reply.
it("includes the deep link when the record has one", () => {
  const c = components(rec({ href: "/?session=s1" } as Partial<NotificationRecord>))
  expect(c.open).toMatchObject({ component: "Link", href: "/?session=s1" })
  expect(mirror(rec({ href: "/?session=s1" } as Partial<NotificationRecord>))).toContain(
    "/?session=s1"
  )
})

it("omits the action row entirely when there is nothing to press", () => {
  const c = components(rec({ actions: [] } as Partial<NotificationRecord>))
  expect(c.actions).toBeUndefined()
  expect(mirror(rec({ actions: [] } as Partial<NotificationRecord>))).not.toContain(
    DEFAULT_NOTIFICATION_CARD_LABELS.replyHint
  )
})

it("drops an empty body rather than rendering a blank line", () => {
  expect(components(rec({ body: "   " } as Partial<NotificationRecord>)).body).toBeUndefined()
})
