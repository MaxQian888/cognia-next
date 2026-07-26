/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { IntlProvider } from "./intl-provider"

const mockClientProvider = jest.fn(({ children }: { children: React.ReactNode }) => children)

jest.mock("next-intl", () => ({
  NextIntlClientProvider: (props: {
    locale: string
    messages: Record<string, unknown>
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
})
