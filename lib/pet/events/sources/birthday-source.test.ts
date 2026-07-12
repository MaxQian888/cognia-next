import {
  createBirthdaySource,
  isBirthdayToday,
  BIRTHDAY_CHECK_INTERVAL_MS,
} from "./birthday-source"
import type { PetActivityRow, PetProfile } from "@/types/pet"
import type { PetEvent } from "@/types/pet"

const HATCH = "2025-07-11T10:00:00"
const BIRTHDAY_NOON = new Date("2026-07-11T12:00:00").getTime()

function profileWithHatch(hatchDate: string | null): PetProfile {
  return {
    soul: hatchDate ? { name: "Boba", personality: "x", hatchDate } : null,
  } as PetProfile
}

function row(kind: string, ts: number): PetActivityRow {
  return { id: 1, kind, source: "system", xp: 10, ts } as PetActivityRow
}

/** Drain the source's async tick chain. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe("isBirthdayToday", () => {
  it("matches the hatch month-day at least one year later", () => {
    expect(isBirthdayToday(HATCH, BIRTHDAY_NOON)).toBe(true)
    // Same day next-next year too.
    expect(isBirthdayToday(HATCH, new Date("2027-07-11T08:00:00").getTime())).toBe(true)
  })

  it("rejects the hatch year itself and non-matching days", () => {
    expect(isBirthdayToday(HATCH, new Date("2025-07-11T12:00:00").getTime())).toBe(false)
    expect(isBirthdayToday(HATCH, new Date("2026-07-12T12:00:00").getTime())).toBe(false)
    expect(isBirthdayToday(HATCH, new Date("2026-08-11T12:00:00").getTime())).toBe(false)
  })

  it("rejects garbage hatch dates", () => {
    expect(isBirthdayToday("not-a-date", BIRTHDAY_NOON)).toBe(false)
    expect(isBirthdayToday("", BIRTHDAY_NOON)).toBe(false)
  })

  it("celebrates Feb-29 hatchlings on Mar-1 in non-leap years and Feb-29 in leap years", () => {
    const feb29Hatch = "2024-02-29T09:00:00"
    expect(isBirthdayToday(feb29Hatch, new Date("2026-03-01T12:00:00").getTime())).toBe(true)
    expect(isBirthdayToday(feb29Hatch, new Date("2026-02-28T12:00:00").getTime())).toBe(false)
    expect(isBirthdayToday(feb29Hatch, new Date("2028-02-29T12:00:00").getTime())).toBe(true)
    expect(isBirthdayToday(feb29Hatch, new Date("2028-03-01T12:00:00").getTime())).toBe(false)
  })
})

describe("createBirthdaySource", () => {
  function build(opts: { profile: PetProfile; rows?: PetActivityRow[]; now?: number }) {
    const emitted: PetEvent[] = []
    const timers: Array<() => void> = []
    const wire = createBirthdaySource({
      now: () => opts.now ?? BIRTHDAY_NOON,
      getProfile: () => Promise.resolve(opts.profile),
      listActivity: () => Promise.resolve(opts.rows ?? []),
      setInterval: (fn) => {
        timers.push(fn)
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {},
    })
    const dispose = wire((e) => emitted.push({ at: Date.now(), ...e } as PetEvent))
    return { emitted, timers, dispose }
  }

  it("emits one birthday event on the anniversary", async () => {
    const { emitted, dispose } = build({ profile: profileWithHatch(HATCH) })
    await settle()
    expect(emitted).toHaveLength(1)
    expect(emitted[0].kind).toBe("birthday")
    expect(emitted[0].source).toBe("system")
    dispose()
  })

  it("stays silent off-anniversary and for unhatched pets", async () => {
    const off = build({
      profile: profileWithHatch(HATCH),
      now: new Date("2026-07-12T12:00:00").getTime(),
    })
    await settle()
    expect(off.emitted).toHaveLength(0)
    off.dispose()

    const egg = build({ profile: profileWithHatch(null) })
    await settle()
    expect(egg.emitted).toHaveLength(0)
    egg.dispose()
  })

  it("dedups against a birthday row already journaled today", async () => {
    const { emitted, dispose } = build({
      profile: profileWithHatch(HATCH),
      rows: [row("birthday", BIRTHDAY_NOON - 3_600_000)],
    })
    await settle()
    expect(emitted).toHaveLength(0)
    dispose()
  })

  it("still celebrates when only OTHER kinds are journaled today", async () => {
    const { emitted, dispose } = build({
      profile: profileWithHatch(HATCH),
      rows: [row("fed", BIRTHDAY_NOON - 60_000), row("birthday", BIRTHDAY_NOON - 86_400_000 * 365)],
    })
    await settle()
    expect(emitted).toHaveLength(1)
    dispose()
  })

  it("re-checks on the interval and never emits after dispose", async () => {
    const { emitted, timers, dispose } = build({ profile: profileWithHatch(HATCH) })
    await settle()
    expect(emitted).toHaveLength(1)
    expect(timers).toHaveLength(1)
    dispose()
    timers[0]()
    await settle()
    expect(emitted).toHaveLength(1)
  })

  it("uses an hourly default cadence", () => {
    expect(BIRTHDAY_CHECK_INTERVAL_MS).toBe(3_600_000)
  })
})
