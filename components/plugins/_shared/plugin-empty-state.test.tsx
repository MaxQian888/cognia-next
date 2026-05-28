import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { PluginEmptyState } from "./plugin-empty-state"

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("PluginEmptyState", () => {
  it("renders default title + hint from the shared i18n namespace", () => {
    renderWithIntl(<PluginEmptyState />)
    expect(screen.getByText(enMessages.plugins.shared.emptyTitle)).toBeInTheDocument()
    expect(screen.getByText(enMessages.plugins.shared.emptyHint)).toBeInTheDocument()
  })

  it("uses role=status so screen readers announce it as a polite region", () => {
    renderWithIntl(<PluginEmptyState />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("renders a custom title + hint when provided", () => {
    renderWithIntl(<PluginEmptyState title="Search returned nothing" hint="Adjust filters" />)
    expect(screen.getByText("Search returned nothing")).toBeInTheDocument()
    expect(screen.getByText("Adjust filters")).toBeInTheDocument()
  })

  it("renders an action button and fires onClick", async () => {
    const onClick = jest.fn()
    renderWithIntl(<PluginEmptyState action={{ label: "Browse marketplace", onClick }} />)
    const btn = screen.getByRole("button", { name: "Browse marketplace" })
    expect(btn).toBeInTheDocument()
    await userEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("does not render an action button when none is supplied", () => {
    renderWithIntl(<PluginEmptyState />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
