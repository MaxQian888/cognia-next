const runtimeNotify = jest.fn().mockResolvedValue("rt-1")
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (input: unknown) => runtimeNotify(input),
}))

import {
  PET_UNAVAILABLE_DEDUPE_KEY,
  PET_UNAVAILABLE_HREF,
  PET_UNAVAILABLE_TTL_MS,
  notifyPetInteractionUnavailable,
} from "./notify-unavailable"

describe("notifyPetInteractionUnavailable", () => {
  it("posts one ambient, self-expiring row that links to where the pet is switched on", async () => {
    const notify = jest.fn().mockResolvedValue("id-1")
    const ok = await notifyPetInteractionUnavailable(
      { title: "Your pet is switched off", body: "Turn it on in Settings → Pet." },
      { notify }
    )
    expect(ok).toBe(true)
    expect(notify).toHaveBeenCalledWith({
      source: "system",
      level: "info",
      title: "Your pet is switched off",
      body: "Turn it on in Settings → Pet.",
      dedupeKey: PET_UNAVAILABLE_DEDUPE_KEY,
      href: PET_UNAVAILABLE_HREF,
      icon: "PawPrint",
      directed: false,
      ttlMs: PET_UNAVAILABLE_TTL_MS,
    })
    expect(PET_UNAVAILABLE_HREF).toBe("/settings?section=pet")
  })

  it("folds repeated presses into one row through a stable dedupe key", async () => {
    const notify = jest.fn().mockResolvedValue("id")
    await notifyPetInteractionUnavailable({ title: "off" }, { notify })
    await notifyPetInteractionUnavailable({ title: "off" }, { notify })
    const keys = notify.mock.calls.map(([input]) => input.dedupeKey)
    expect(new Set(keys)).toEqual(new Set([PET_UNAVAILABLE_DEDUPE_KEY]))
  })

  it("defaults to the notification center runtime when no notify is injected", async () => {
    await expect(notifyPetInteractionUnavailable({ title: "off" })).resolves.toBe(true)
    expect(runtimeNotify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "off", dedupeKey: PET_UNAVAILABLE_DEDUPE_KEY })
    )
  })

  it("swallows a failing notify and reports false, so a key press never throws", async () => {
    const notify = jest.fn().mockRejectedValue(new Error("center down"))
    await expect(notifyPetInteractionUnavailable({ title: "x" }, { notify })).resolves.toBe(false)
  })
})
