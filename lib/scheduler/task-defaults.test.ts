import { defaultTaskTimezone, seedTaskDefaults } from "./task-defaults"
import type { CreateScheduledTaskInput, TaskDefaults } from "@/types/scheduler"

const defaults: TaskDefaults = {
  timezone: "Asia/Shanghai",
  notification: { onStart: true, channels: ["desktop", "im"], webhookUrl: "https://x/hook" },
  execution: { timeout: 120_000, maxRetries: 5 },
}

describe("seedTaskDefaults", () => {
  it("returns undefined when there are no defaults and no draft", () => {
    expect(seedTaskDefaults(undefined)).toBeUndefined()
  })

  it("seeds notification + execution defaults onto a blank create", () => {
    const seeded = seedTaskDefaults(defaults)
    expect(seeded?.notification).toEqual({
      onStart: true,
      channels: ["desktop", "im"],
      webhookUrl: "https://x/hook",
    })
    expect(seeded?.config).toEqual({ timeout: 120_000, maxRetries: 5 })
  })

  it("does not invent a trigger for a blank create", () => {
    // A trigger without a `type` is not a trigger; the blank sheet gets its
    // timezone from `defaultTaskTimezone` instead.
    expect(seedTaskDefaults(defaults)?.trigger).toBeUndefined()
  })

  it("lets a handed-over draft win over every default it names", () => {
    const draft: Partial<CreateScheduledTaskInput> = {
      name: "From the composer",
      notification: { onStart: false, channels: ["toast"] },
      config: { timeout: 5_000 },
    }
    const seeded = seedTaskDefaults(defaults, draft)
    expect(seeded?.name).toBe("From the composer")
    expect(seeded?.notification).toMatchObject({ onStart: false, channels: ["toast"] })
    expect(seeded?.config).toMatchObject({ timeout: 5_000 })
  })

  it("fills only the keys the draft left unset", () => {
    const seeded = seedTaskDefaults(defaults, { config: { timeout: 5_000 } })
    expect(seeded?.config).toEqual({ timeout: 5_000, maxRetries: 5 })
    // The draft named no notification at all, so the default stands whole.
    expect(seeded?.notification).toMatchObject({ onStart: true })
  })

  it("treats an empty draft value as 'unset' rather than as an override", () => {
    const seeded = seedTaskDefaults(defaults, {
      notification: { channels: [], webhookUrl: "" },
    })
    expect(seeded?.notification).toMatchObject({
      channels: ["desktop", "im"],
      webhookUrl: "https://x/hook",
    })
  })

  it("drops a default the user cleared so the form's own literal wins", () => {
    const seeded = seedTaskDefaults({ notification: { channels: [], webhookUrl: "  " } })
    expect(seeded).toBeUndefined()
  })

  it("seeds the timezone onto a draft that already has a trigger", () => {
    const seeded = seedTaskDefaults(defaults, { trigger: { type: "cron" } })
    expect(seeded?.trigger).toEqual({ type: "cron", timezone: "Asia/Shanghai" })
  })

  it("never overwrites a timezone the draft chose", () => {
    const seeded = seedTaskDefaults(defaults, {
      trigger: { type: "cron", timezone: "Europe/Berlin" },
    })
    expect(seeded?.trigger?.timezone).toBe("Europe/Berlin")
  })

  it("passes a draft through untouched when there are no defaults", () => {
    const draft: Partial<CreateScheduledTaskInput> = { name: "x", trigger: { type: "once" } }
    expect(seedTaskDefaults(undefined, draft)).toEqual(draft)
  })
})

describe("defaultTaskTimezone", () => {
  it("returns the configured timezone", () => {
    expect(defaultTaskTimezone(defaults)).toBe("Asia/Shanghai")
  })

  it("returns undefined for an absent or blank default", () => {
    expect(defaultTaskTimezone(undefined)).toBeUndefined()
    expect(defaultTaskTimezone({ timezone: "   " })).toBeUndefined()
  })
})
