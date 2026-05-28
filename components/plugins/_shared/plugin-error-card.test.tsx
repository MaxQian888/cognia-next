import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { PluginErrorCard } from "./plugin-error-card"

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("PluginErrorCard", () => {
  it("renders the supplied message verbatim", () => {
    renderWithIntl(<PluginErrorCard message="Network unreachable" />)
    expect(screen.getByText("Network unreachable")).toBeInTheDocument()
  })

  it("uses the shared default title when not overridden", () => {
    renderWithIntl(<PluginErrorCard message="boom" />)
    expect(screen.getByText(enMessages.plugins.shared.errorTitle)).toBeInTheDocument()
  })

  it("renders a custom title when provided", () => {
    renderWithIntl(<PluginErrorCard title="Marketplace offline" message="boom" />)
    expect(screen.getByText("Marketplace offline")).toBeInTheDocument()
  })

  it("renders a Retry button when onRetry is supplied and fires it on click", async () => {
    const onRetry = jest.fn()
    renderWithIntl(<PluginErrorCard message="boom" onRetry={onRetry} />)
    const btn = screen.getByRole("button", { name: enMessages.plugins.shared.retry })
    await userEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("does not render the Retry button when onRetry is omitted", () => {
    renderWithIntl(<PluginErrorCard message="boom" />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("uses role=alert so screen readers announce the failure assertively", () => {
    renderWithIntl(<PluginErrorCard message="boom" />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })
})
