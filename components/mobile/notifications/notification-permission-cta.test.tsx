/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { NOTIFICATION_PERMISSION_GRANTED_EVENT } from "@/lib/capacitor/local-notifications"

import { NotificationPermissionCta } from "./notification-permission-cta"

const messages = {
  mobile: {
    notifications: {
      permissionCta: {
        title: "Enable background reminders",
        description:
          "Cognia can notify you when a long-running task or scheduled backup needs attention.",
        descriptionDenied:
          "Notifications were denied. Open Settings → Cognia → Notifications to allow them.",
        enableButton: "Enable",
        enableInProgress: "Requesting…",
        settingsButton: "Open Settings",
      },
    },
  },
}

function renderCta(props: Parameters<typeof NotificationPermissionCta>[0]) {
  const resumeSubscriber = props.resumeSubscriber ?? jest.fn(async () => () => {})
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NotificationPermissionCta resumeSubscriber={resumeSubscriber} {...props} />
    </NextIntlClientProvider>
  )
}

describe("NotificationPermissionCta", () => {
  it("renders nothing when permission is already granted", async () => {
    const checker = jest.fn().mockResolvedValue({ kind: "ok", value: "granted" })
    const onGranted = jest.fn()
    window.addEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)
    renderCta({ checker })
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("notification-permission-cta")).toBeNull()
    window.removeEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)
  })

  it("renders nothing on unsupported platforms (web / Tauri)", async () => {
    const checker = jest.fn().mockResolvedValue({ kind: "unsupported" })
    renderCta({ checker })
    await waitFor(() => expect(checker).toHaveBeenCalled())
    expect(screen.queryByTestId("notification-permission-cta")).toBeNull()
  })

  it("shows the Enable button when permission is in prompt state", async () => {
    const checker = jest.fn().mockResolvedValue({ kind: "ok", value: "prompt" })
    renderCta({ checker })
    expect(await screen.findByTestId("notification-permission-cta-enable")).toBeInTheDocument()
  })

  it("requests permission on click and hides on granted", async () => {
    const user = userEvent.setup()
    const checker = jest.fn().mockResolvedValue({ kind: "ok", value: "prompt" })
    const requester = jest.fn().mockResolvedValue({ kind: "ok", value: "granted" })
    const onGranted = jest.fn()
    window.addEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)
    renderCta({ checker, requester })

    const button = await screen.findByTestId("notification-permission-cta-enable")
    await user.click(button)
    await waitFor(() => expect(requester).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId("notification-permission-cta")).toBeNull())
    expect(onGranted).toHaveBeenCalledTimes(1)
    window.removeEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)
  })

  it("switches to settings CTA when user denies", async () => {
    const user = userEvent.setup()
    const checker = jest.fn().mockResolvedValue({ kind: "ok", value: "prompt" })
    const requester = jest.fn().mockResolvedValue({ kind: "ok", value: "denied" })
    renderCta({ checker, requester })

    await user.click(await screen.findByTestId("notification-permission-cta-enable"))
    expect(await screen.findByTestId("notification-permission-cta-settings")).toBeInTheDocument()
  })

  it("opens app settings on the settings CTA", async () => {
    const user = userEvent.setup()
    const checker = jest.fn().mockResolvedValue({ kind: "ok", value: "denied" })
    const settingsOpener = jest.fn().mockResolvedValue({ kind: "ok" })
    renderCta({ checker, settingsOpener })

    const button = await screen.findByTestId("notification-permission-cta-settings")
    await user.click(button)
    await waitFor(() => expect(settingsOpener).toHaveBeenCalled())
  })

  it("re-checks permission on app resume and publishes a settings grant", async () => {
    let resumeHandler: (() => void) | undefined
    const unsubscribe = jest.fn()
    const resumeSubscriber = jest.fn(async (handler: () => void) => {
      resumeHandler = handler
      return unsubscribe
    })
    const checker = jest
      .fn()
      .mockResolvedValueOnce({ kind: "ok", value: "denied" })
      .mockResolvedValueOnce({ kind: "ok", value: "granted" })
    const onGranted = jest.fn()
    window.addEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)

    const { unmount } = renderCta({ checker, resumeSubscriber })
    expect(await screen.findByTestId("notification-permission-cta-settings")).toBeInTheDocument()
    await waitFor(() => expect(resumeSubscriber).toHaveBeenCalledTimes(1))

    await act(async () => {
      resumeHandler?.()
    })

    await waitFor(() => expect(checker).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("notification-permission-cta")).toBeNull()

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    window.removeEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, onGranted)
  })
})
