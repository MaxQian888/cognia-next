import { getLocalCloudProvider, LOCAL_CLOUD_PROVIDERS } from "./local-cloud-providers"

describe("local cloud backup providers", () => {
  it("covers the major desktop-synced folders with official HTTPS guides", () => {
    expect(LOCAL_CLOUD_PROVIDERS.map((provider) => provider.id)).toEqual([
      "google-drive",
      "dropbox",
      "onedrive",
      "icloud-drive",
    ])
    for (const provider of LOCAL_CLOUD_PROVIDERS) {
      expect(provider.docsUrl).toMatch(/^https:\/\//)
    }
  })

  it("resolves one supported provider", () => {
    expect(getLocalCloudProvider("onedrive").docsUrl).toContain("microsoft.com")
  })
})
