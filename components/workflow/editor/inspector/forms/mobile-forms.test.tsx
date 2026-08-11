import {
  ApprovalRequestConfig,
  MobileCameraConfig,
  MobileScanBarcodeConfig,
  MobileLocationConfig,
  MobileShareConfig,
  MobileNotifyConfig,
} from "./mobile-forms"

describe("mobile-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        ApprovalRequestConfig,
        MobileCameraConfig,
        MobileScanBarcodeConfig,
        MobileLocationConfig,
        MobileShareConfig,
        MobileNotifyConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
