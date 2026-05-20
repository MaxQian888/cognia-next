/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

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
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NotificationPermissionCta {...props} />
    </NextIntlClientProvider>
  )
}

describe("NotificationPermissionCta", () => {
  it("renders nothing when permission is already granted", async () => {
    const checker = jest.fn().mockResolvedValue({ kind: "ok", value: "granted" })
    renderCta({ checker })
    await waitFor(() => expect(checker).toHaveBeenCalled())
    expect(screen.queryByTestId("notification-permission-cta")).toBeNull()
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
    renderCta({ checker, requester })

    const button = await screen.findByTestId("notification-permission-cta-enable")
    await user.click(button)
    await waitFor(() => expect(requester).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId("notification-permission-cta")).toBeNull())
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
})
