/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { DOCS_TIME_ZONE } from "../lib/time-zone"
import { IntlProvider } from "./intl-provider"

const mockClientProvider = jest.fn(({ children }: { children: React.ReactNode }) => children)

jest.mock("next-intl", () => ({
  NextIntlClientProvider: (props: {
    locale: string
    messages: Record<string, unknown>
    timeZone?: string
    children: React.ReactNode
  }) => mockClientProvider(props),
}))

describe("IntlProvider", () => {
  it("passes explicit locale and messages to the client provider", () => {
    const messages = { docsSite: { heading: "Docs" } }

    render(
      <IntlProvider locale="en" messages={messages}>
        <span>content</span>
      </IntlProvider>
    )

    expect(screen.getByText("content")).toBeInTheDocument()
    expect(mockClientProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "en",
        messages,
      })
    )
  })

  it("pins a global time zone so prerendering never falls back to the build host", () => {
    // Without this, `useTranslations()` reports ENVIRONMENT_FALLBACK once per
    // prerender worker during `pnpm docs:build`.
    render(
      <IntlProvider locale="en" messages={{}}>
        <span>content</span>
      </IntlProvider>
    )

    expect(mockClientProvider).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: DOCS_TIME_ZONE })
    )
  })
})
