const mockCanUseTauriInvoke = jest.fn(() => true)
jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  canUseTauriInvoke: () => mockCanUseTauriInvoke(),
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { InstallButton } from "./install-button"

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("InstallButton", () => {
  it("renders the install label when not installed and fires onInstall", async () => {
    const onInstall = jest.fn()
    renderWithIntl(<InstallButton installed={false} installing={false} onInstall={onInstall} />)
    const btn = screen.getByRole("button", { name: enMessages.plugins.shared.install })
    await userEvent.click(btn)
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it("renders the uninstall label and fires onUninstall when installed=true", async () => {
    const onInstall = jest.fn()
    const onUninstall = jest.fn()
    renderWithIntl(
      <InstallButton installed installing={false} onInstall={onInstall} onUninstall={onUninstall} />
    )
    const btn = screen.getByRole("button", { name: enMessages.plugins.shared.uninstall })
    await userEvent.click(btn)
    expect(onUninstall).toHaveBeenCalledTimes(1)
    expect(onInstall).not.toHaveBeenCalled()
  })

  it("shows the installing label and is disabled while installing", () => {
    renderWithIntl(<InstallButton installed={false} installing onInstall={() => {}} />)
    const btn = screen.getByRole("button", { name: enMessages.plugins.shared.installing })
    expect(btn).toBeDisabled()
  })

  it("shows the uninstalling label when installed + installing", () => {
    renderWithIntl(
      <InstallButton installed installing onInstall={() => {}} onUninstall={() => {}} />
    )
    expect(
      screen.getByRole("button", { name: enMessages.plugins.shared.uninstalling })
    ).toBeInTheDocument()
  })

  it("falls back to the install (not uninstall) behavior when no onUninstall is supplied", async () => {
    const onInstall = jest.fn()
    renderWithIntl(<InstallButton installed installing={false} onInstall={onInstall} />)
    const btn = screen.getByRole("button", { name: enMessages.plugins.shared.install })
    await userEvent.click(btn)
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it("respects the explicit disabled prop", () => {
    renderWithIntl(
      <InstallButton installed={false} installing={false} onInstall={() => {}} disabled />
    )
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("uses custom install / installing labels when provided", () => {
    renderWithIntl(
      <InstallButton
        installed={false}
        installing={false}
        onInstall={() => {}}
        installLabel="Add to workspace"
      />
    )
    expect(screen.getByRole("button", { name: "Add to workspace" })).toBeInTheDocument()
  })
})

/**
 * `PluginMarketplace.installPlugin` refuses off the desktop shell: the
 * download and its checksum verification run in the Rust backend. Nothing
 * surfaced that, so on the web the button looked live and the user learned
 * the truth from a toast carrying an un-translated English sentence.
 */
describe("desktop host gate", () => {
  beforeEach(() => {
    mockCanUseTauriInvoke.mockReturnValue(false)
  })

  it("disables install off the desktop shell and marks why", async () => {
    const onInstall = jest.fn()
    renderWithIntl(<InstallButton installed={false} installing={false} onInstall={onInstall} />)
    const button = screen.getByRole("button")
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("data-host-blocked", "true")
    await userEvent.click(button)
    expect(onInstall).not.toHaveBeenCalled()
  })

  // Removing a row is a Dexie delete, which works on every host.
  it("leaves uninstall alone", async () => {
    const onUninstall = jest.fn()
    render(
      <InstallButton installed installing={false} onInstall={jest.fn()} onUninstall={onUninstall} />
    )
    const button = screen.getByRole("button")
    expect(button).not.toBeDisabled()
    expect(button).not.toHaveAttribute("data-host-blocked")
    await userEvent.click(button)
    expect(onUninstall).toHaveBeenCalled()
  })

  it("can be opted out of by a surface that does not use the backend", async () => {
    const onInstall = jest.fn()
    renderWithIntl(
      <InstallButton installed={false} installing={false} onInstall={onInstall} skipHostGate />
    )
    const button = screen.getByRole("button")
    expect(button).not.toBeDisabled()
    await userEvent.click(button)
    expect(onInstall).toHaveBeenCalled()
  })

  it("does not gate anything on the desktop shell", () => {
    mockCanUseTauriInvoke.mockReturnValue(true)
    renderWithIntl(<InstallButton installed={false} installing={false} onInstall={jest.fn()} />)
    expect(screen.getByRole("button")).not.toBeDisabled()
  })
})
