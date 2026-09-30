import { ensureDeviceChannelReady } from "./device-channel-gate"

jest.mock("@/lib/capacitor/local-notifications", () => ({
  emitNotificationPermissionGranted: jest.fn(),
  requestPermission: jest.fn(),
}))
jest.mock("@/lib/push/push-notifications", () => ({ registerPushNotifications: jest.fn() }))

const mobile = () => true

describe("ensureDeviceChannelReady", () => {
  it("lets every change through off the native shell", async () => {
    const requestLocalPermission = jest.fn()
    await expect(
      ensureDeviceChannelReady("os", { isNativeMobile: () => false, requestLocalPermission })
    ).resolves.toEqual({ kind: "allowed" })
    expect(requestLocalPermission).not.toHaveBeenCalled()
  })

  it("never asks the platform for the in-app toast channel", async () => {
    const requestLocalPermission = jest.fn()
    await expect(
      ensureDeviceChannelReady("toast", { isNativeMobile: mobile, requestLocalPermission })
    ).resolves.toEqual({ kind: "allowed" })
    expect(requestLocalPermission).not.toHaveBeenCalled()
  })

  it("requests the notification permission for system notifications", async () => {
    const onPermissionGranted = jest.fn()
    const granted = await ensureDeviceChannelReady("os", {
      isNativeMobile: mobile,
      requestLocalPermission: async () => ({ kind: "ok", value: "granted" }),
      onPermissionGranted,
    })
    expect(granted).toEqual({ kind: "allowed" })
    expect(onPermissionGranted).toHaveBeenCalledTimes(1)

    await expect(
      ensureDeviceChannelReady("os", {
        isNativeMobile: mobile,
        requestLocalPermission: async () => ({ kind: "ok", value: "denied" }),
      })
    ).resolves.toEqual({ kind: "denied" })

    await expect(
      ensureDeviceChannelReady("os", {
        isNativeMobile: mobile,
        requestLocalPermission: async () => ({ kind: "error", message: "bridge down" }),
      })
    ).resolves.toEqual({ kind: "unavailable", reason: "bridge down" })

    await expect(
      ensureDeviceChannelReady("os", {
        isNativeMobile: mobile,
        requestLocalPermission: async () => ({ kind: "unsupported" }),
      })
    ).resolves.toEqual({ kind: "unavailable", reason: "local notifications unsupported" })
  })

  it("requires a real push registration for push notifications", async () => {
    const onPermissionGranted = jest.fn()
    const registerPush = jest.fn(async () => ({
      kind: "registered" as const,
      token: "t",
      platform: "android" as const,
    }))
    await expect(
      ensureDeviceChannelReady("push", {
        isNativeMobile: mobile,
        registerPush,
        onPermissionGranted,
      })
    ).resolves.toEqual({ kind: "allowed" })
    expect(registerPush).toHaveBeenCalledWith({ requestPermission: true })
    expect(onPermissionGranted).toHaveBeenCalled()

    await expect(
      ensureDeviceChannelReady("push", {
        isNativeMobile: mobile,
        registerPush: async () => ({ kind: "permission_denied" }),
      })
    ).resolves.toEqual({ kind: "denied" })

    // A device without Google Play services: the token never arrives.
    await expect(
      ensureDeviceChannelReady("push", {
        isNativeMobile: mobile,
        registerPush: async () => ({ kind: "registration_failed", message: "no GMS" }),
      })
    ).resolves.toEqual({ kind: "unavailable", reason: "no GMS" })

    await expect(
      ensureDeviceChannelReady("push", {
        isNativeMobile: mobile,
        registerPush: async () => ({ kind: "unsupported" }),
      })
    ).resolves.toEqual({ kind: "unavailable", reason: "push notifications unsupported" })
  })
})
