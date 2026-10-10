import { fileSharingPolicyHref, networkDriveSettingsHref } from "./settings-links"

describe("live-share settings links", () => {
  it("points at the policy card on the data backup tab", () => {
    const url = new URL(fileSharingPolicyHref(), "http://x")
    expect(url.pathname).toBe("/settings")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      section: "data",
      focus: "file-sharing-policy",
      dataTab: "backup",
    })
  })

  it("points at the network drive panel", () => {
    const url = new URL(networkDriveSettingsHref(), "http://x")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      section: "connectivity",
      connectivityPanel: "network-drive",
    })
  })
})
