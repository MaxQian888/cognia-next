/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { PluginContext } from "@cognia/plugin-sdk"
import { TemplatePanel } from "./panel"

jest.mock("@cognia/plugin-ui", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

function makeContext() {
  const translate = jest.fn((key: string, values?: Record<string, unknown>) =>
    key === "panel.clicked" ? `localized:${values?.count}` : `localized:${key}`
  )
  const onLocaleChange = jest.fn(() => jest.fn())
  const ctx = {
    theme: {
      getTheme: () => ({ motion: { reduced: true, durationScale: 1 } }),
    },
    i18n: {
      getCurrentLocale: () => "en",
      onLocaleChange,
      t: translate,
    },
  } as unknown as PluginContext

  return { ctx, translate, onLocaleChange }
}

describe("TemplatePanel", () => {
  it("renders translated status and count, then subscribes to locale changes", () => {
    const { ctx, translate, onLocaleChange } = makeContext()

    render(
      <TemplatePanel
        pluginId="cognia-plugin-template-ts"
        extensionId="template-panel"
        formFactor="row"
        ctx={ctx}
      />
    )

    expect(screen.getByText("localized:panel.status.static")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "localized:0" })).toBeInTheDocument()
    expect(onLocaleChange).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "localized:0" }))

    expect(screen.getByRole("button", { name: "localized:1" })).toBeInTheDocument()
    expect(translate).toHaveBeenCalledWith("panel.clicked", { count: 1 })
  })
})
