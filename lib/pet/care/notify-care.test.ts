import { CARE_UNWELL_DEDUPE_KEY, notifyBecameUnwell } from "./notify-care"

describe("notifyBecameUnwell", () => {
  it("calls notify with the system care payload and returns true", async () => {
    const notify = jest.fn().mockResolvedValue("id-1")
    const ok = await notifyBecameUnwell(
      { title: "Pip feels low", body: "Give some care" },
      { notify }
    )
    expect(ok).toBe(true)
    expect(notify).toHaveBeenCalledWith({
      source: "system",
      level: "info",
      title: "Pip feels low",
      body: "Give some care",
      dedupeKey: CARE_UNWELL_DEDUPE_KEY,
      icon: "Heart",
      directed: true,
    })
  })

  it("swallows notify failures and returns false", async () => {
    const notify = jest.fn().mockRejectedValue(new Error("boom"))
    const ok = await notifyBecameUnwell({ title: "x" }, { notify })
    expect(ok).toBe(false)
  })
})
