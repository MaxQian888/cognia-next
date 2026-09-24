/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import messages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { SecretStoreReadiness } from "@/lib/credentials/secret-store-readiness"

import { SecretStoreLockedNotice } from "./secret-store-locked-notice"

function renderNotice(props: Partial<React.ComponentProps<typeof SecretStoreLockedNotice>> = {}) {
  const onUnlock = props.onUnlock ?? jest.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SecretStoreLockedNotice
        readiness={props.readiness ?? "locked"}
        unlocking={props.unlocking ?? false}
        failed={props.failed ?? false}
        onUnlock={onUnlock}
      />
    </NextIntlClientProvider>
  )
  return { onUnlock, ...view }
}

describe("SecretStoreLockedNotice", () => {
  it.each<SecretStoreReadiness>(["uninitialized", "initializing", "ready"])(
    "renders nothing while the store is %s",
    (readiness) => {
      const { container } = renderNotice({ readiness })
      expect(container).toBeEmptyDOMElement()
    }
  )

  it("explains the locked store and runs the explicit unlock on click", async () => {
    const user = userEvent.setup()
    const { onUnlock } = renderNotice()
    expect(screen.getByRole("region", { name: "Secure storage status" })).toBeInTheDocument()
    expect(screen.getByText("Secure storage is locked")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Unlock" }))
    expect(onUnlock).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Unlock did not succeed/)).not.toBeInTheDocument()
  })

  it("disables the button while an unlock is in flight", () => {
    renderNotice({ unlocking: true })
    const button = screen.getByRole("button", { name: "Unlocking…" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")
  })

  it("announces a failed unlock and keeps Retry available", () => {
    renderNotice({ failed: true })
    expect(screen.getByText(/Unlock did not succeed/)).toHaveAttribute("role", "alert")
    expect(screen.getByRole("button", { name: "Unlock" })).toBeEnabled()
  })

  it("ships every notice string in Simplified Chinese", () => {
    const en = messages.safeMode.secretStore
    const zh = zhMessages.safeMode.secretStore
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zh[key]).toBeTruthy()
      expect(zh[key]).not.toBe(en[key])
    }
  })
})
