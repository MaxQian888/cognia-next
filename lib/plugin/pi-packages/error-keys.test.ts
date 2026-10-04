import enMessages from "@/i18n/messages/en/plugins/piPackages.json"
import zhMessages from "@/i18n/messages/zh-CN/plugins/piPackages.json"
import { PI_PACKAGE_ERROR_KEYS, piPackageErrorKey } from "./error-keys"

describe("PI_PACKAGE_ERROR_KEYS", () => {
  it("points every code at a message present in both locales", () => {
    for (const key of Object.values(PI_PACKAGE_ERROR_KEYS)) {
      expect(enMessages.errors).toHaveProperty(key)
      expect(zhMessages.errors).toHaveProperty(key)
    }
  })

  it("falls back for unknown or missing codes", () => {
    expect(piPackageErrorKey("pi-version", "x")).toBe("piVersion")
    expect(piPackageErrorKey("brand-new-code", "resolutionFailed")).toBe("resolutionFailed")
    expect(piPackageErrorKey(undefined, "executionFailed")).toBe("executionFailed")
    // Prototype keys are not codes.
    expect(piPackageErrorKey("toString", "executionFailed")).toBe("executionFailed")
  })
})
