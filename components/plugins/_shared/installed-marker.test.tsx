import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { TooltipProvider } from "@/components/ui/tooltip"
import { InstalledMarker } from "./installed-marker"

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("InstalledMarker", () => {
  it("renders the Installed label by default", () => {
    renderWithIntl(<InstalledMarker />)
    expect(screen.getByText(enMessages.plugins.shared.installed)).toBeInTheDocument()
    expect(screen.getByTestId("installed-marker")).toBeInTheDocument()
  })

  it("renders the desktop-only badge instead when desktopOnly=true", () => {
    renderWithIntl(<InstalledMarker desktopOnly />)
    // The text matches the desktopOnly i18n key. There are two copies because
    // the Tooltip content also carries the same message — we just need at
    // least one match on screen.
    expect(
      screen.getAllByText(enMessages.plugins.shared.installedDesktopOnly).length
    ).toBeGreaterThan(0)
    expect(screen.getByTestId("installed-marker-desktop-only")).toBeInTheDocument()
  })

  it("does not render the success marker when desktopOnly=true", () => {
    renderWithIntl(<InstalledMarker desktopOnly />)
    expect(screen.queryByTestId("installed-marker")).not.toBeInTheDocument()
  })

  it("does not render the desktop-only marker by default", () => {
    renderWithIntl(<InstalledMarker />)
    expect(screen.queryByTestId("installed-marker-desktop-only")).not.toBeInTheDocument()
  })
})
