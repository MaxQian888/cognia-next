import {
  detectWebDavProvider,
  getWebDavProviderPreset,
  WEBDAV_PROVIDER_PRESETS,
} from "./provider-presets"

describe("WebDAV provider presets", () => {
  it("keeps documented hosted endpoints exact", () => {
    expect(getWebDavProviderPreset("nutstore").baseUrl).toBe("https://dav.jianguoyun.com/dav")
    expect(getWebDavProviderPreset("koofr").baseUrl).toBe("https://app.koofr.net/dav/Koofr")
    expect(getWebDavProviderPreset("pcloud-us").baseUrl).toBe("https://webdav.pcloud.com")
    expect(getWebDavProviderPreset("pcloud-eu").baseUrl).toBe("https://ewebdav.pcloud.com")
    expect(getWebDavProviderPreset("yandex").baseUrl).toBe("https://webdav.yandex.ru")
  })

  it("keeps self-hosted endpoints user-supplied", () => {
    expect(getWebDavProviderPreset("generic").baseUrl).toBeUndefined()
    expect(getWebDavProviderPreset("nextcloud").baseUrl).toBeUndefined()
    expect(getWebDavProviderPreset("owncloud").baseUrl).toBeUndefined()
  })

  it("gives every provider an HTTPS official documentation link", () => {
    expect(WEBDAV_PROVIDER_PRESETS).not.toHaveLength(0)
    for (const preset of WEBDAV_PROVIDER_PRESETS) {
      expect(preset.docsUrl).toMatch(/^https:\/\//)
    }
  })

  it("detects hosted providers without misclassifying self-hosted URLs", () => {
    expect(detectWebDavProvider("https://dav.jianguoyun.com/dav/")).toBe("nutstore")
    expect(detectWebDavProvider("https://app.koofr.net/dav/Koofr")).toBe("koofr")
    expect(detectWebDavProvider("https://webdav.pcloud.com")).toBe("pcloud-us")
    expect(detectWebDavProvider("https://ewebdav.pcloud.com")).toBe("pcloud-eu")
    expect(detectWebDavProvider("https://webdav.yandex.ru")).toBe("yandex")
    expect(detectWebDavProvider("https://cloud.example.com/remote.php/dav/files/alice")).toBe(
      "generic"
    )
  })
})
