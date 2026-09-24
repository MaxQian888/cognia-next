import type { NotificationAction, NotificationRecord } from "@/types/notifications"

import type {
  FunctionalToastActionSpec,
  FunctionalToastContext,
  FunctionalToastFactory,
  FunctionalToastSpec,
  FunctionalToastTone,
} from "./types"

// types.ts is the functional-toast contract — pure types, so the suite pins
// the shape: a spec/frame/registry refactor that breaks the contract fails
// here at tsc time, not at the toaster.

describe("functional toast spec contract", () => {
  it("requires title and a toned eyebrow; everything else is optional", () => {
    const minimal = {
      icon: null,
      eyebrow: { text: "DUE NOW", tone: "live" },
      title: "Nightly digest",
    } satisfies FunctionalToastSpec

    // @ts-expect-error The eyebrow tone is required — toneless status lines
    // would render against an undefined TONE entry in the frame.
    const toneless: FunctionalToastSpec["eyebrow"] = { text: "DUE NOW" }
    // @ts-expect-error The title is the one piece of copy the frame cannot
    // synthesize — a spec without it is meaningless.
    const titleless: FunctionalToastSpec = { icon: null, eyebrow: minimal.eyebrow }

    expect(minimal.eyebrow.tone).toBe("live")
    expect(toneless.pulse).toBeUndefined()
    expect(titleless.title).toBeUndefined()
  })

  it("links card actions back to persisted NotificationActions", () => {
    const persisted: NotificationAction = {
      id: "open",
      label: "Open",
      command: "scheduler.open-task",
      args: { taskId: "t-1" },
      variant: "primary",
    }
    const action = {
      id: "open",
      label: "Open",
      strong: true,
      notificationAction: persisted,
    } satisfies FunctionalToastActionSpec

    // @ts-expect-error Action tone is "default" | "danger" — no other levels,
    // the frame styles exactly those two plus the `strong` emphasis flag.
    const loud: FunctionalToastActionSpec["tone"] = "warning"

    expect(action.notificationAction?.command).toBe("scheduler.open-task")
    expect(loud).toBe("warning")
  })

  it("keeps the eyebrow tone set closed over the frame's palette", () => {
    const tones: FunctionalToastTone[] = ["live", "ok", "warn", "danger", "muted"]
    // @ts-expect-error Tones the frame has no palette for are rejected.
    const unknown: FunctionalToastTone = "info"
    expect(tones).toHaveLength(5)
    expect(unknown).toBe("info")
  })
})

describe("functional toast factory contract", () => {
  it("receives the record plus a localization context and may decline", () => {
    const ctx: FunctionalToastContext = {
      t: (key) => key,
      locale: "en",
      now: 1_700_000_000_000,
      triggerText: () => "every 4h",
    }
    const decline: FunctionalToastFactory = () => null
    const accept: FunctionalToastFactory = (rec: NotificationRecord) => ({
      icon: null,
      eyebrow: { text: ctx.t("eyebrow"), tone: "live", pulse: true },
      title: rec.title,
      footnote: ctx.triggerText({} as Parameters<typeof ctx.triggerText>[0]),
    })

    expect(decline({} as NotificationRecord, ctx)).toBeNull()
    expect(accept({ title: "Nightly digest" } as NotificationRecord, ctx)?.title).toBe(
      "Nightly digest"
    )
  })
})
