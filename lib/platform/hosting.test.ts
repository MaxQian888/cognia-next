import { isHostingHere, resolveHostingState } from "./hosting"

describe("resolveHostingState", () => {
  it("is hosting only with host mode on, the capability, and no remote routing", () => {
    expect(resolveHostingState({ hostMode: true, hasAlwaysOn: true, remoteActive: false })).toBe(
      "hosting"
    )
    expect(isHostingHere({ hostMode: true, hasAlwaysOn: true, remoteActive: false })).toBe(true)
  })

  it("stands by while the desktop drives another host", () => {
    // The static capability still holds here; reading it alone would call
    // this desktop a host while another machine does the work.
    expect(resolveHostingState({ hostMode: true, hasAlwaysOn: true, remoteActive: true })).toBe(
      "standing-by"
    )
    expect(isHostingHere({ hostMode: true, hasAlwaysOn: true, remoteActive: true })).toBe(false)
  })

  it("is off without host mode, whatever the routing", () => {
    for (const remoteActive of [false, true]) {
      expect(resolveHostingState({ hostMode: false, hasAlwaysOn: true, remoteActive })).toBe("off")
    }
  })

  it("is unsupported on a shell without long-lived runners", () => {
    expect(resolveHostingState({ hostMode: true, hasAlwaysOn: false, remoteActive: false })).toBe(
      "unsupported"
    )
    expect(isHostingHere({ hostMode: true, hasAlwaysOn: false, remoteActive: false })).toBe(false)
  })
})
