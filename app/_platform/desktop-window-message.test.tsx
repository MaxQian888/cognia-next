import { render, screen } from "@testing-library/react"
import { startupMessages } from "@/i18n/messages"
import { DesktopWindowMessage } from "./desktop-window-message"

let mockLocale: "en" | "zh-CN" = "en"
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    if (namespace !== "common") throw new Error(`Unexpected namespace: ${namespace}`)
    return startupMessages[mockLocale].common[key as keyof typeof startupMessages.en.common]
  },
}))

it.each(["en", "zh-CN"] as const)(
  "offers a way back using the %s startup catalog without account boot",
  (locale) => {
    const messages = startupMessages[locale]
    mockLocale = locale
    render(<DesktopWindowMessage />)
    expect(screen.getByRole("heading", { name: messages.common.desktopOnly })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: messages.common.backToApp })).toHaveAttribute(
      "href",
      "/"
    )
  }
)
