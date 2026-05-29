import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { PluginLicense } from "./plugin-license"

const messages = {
  plugins: {
    license: {
      label: "License",
      custom: "Custom",
      view: "View full license",
      hide: "Hide license",
    },
  },
}

function renderWith(props: Parameters<typeof PluginLicense>[0]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PluginLicense {...props} />
    </NextIntlClientProvider>
  )
}

describe("PluginLicense", () => {
  it("renders nothing without a license or text", () => {
    const { container } = renderWith({})
    expect(container.firstChild).toBeNull()
  })

  it("shows the SPDX badge", () => {
    renderWith({ license: "MIT" })
    expect(screen.getByText("MIT")).toBeInTheDocument()
    // No text → no toggle button.
    expect(screen.queryByText("View full license")).not.toBeInTheDocument()
  })

  it("toggles the full license text", () => {
    renderWith({ license: "MIT", licenseText: "MIT License\n\nPermission..." })
    expect(screen.queryByText(/Permission/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("View full license"))
    expect(screen.getByText(/Permission/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Hide license"))
    expect(screen.queryByText(/Permission/)).not.toBeInTheDocument()
  })

  it("labels a custom (non-SPDX) license when only text is present", () => {
    // jest.setup mocks next-intl to the real en.json — assert its value.
    renderWith({ licenseText: "All rights reserved" })
    expect(screen.getByText("Custom license")).toBeInTheDocument()
  })
})
