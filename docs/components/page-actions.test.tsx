/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { PageActions } from "./page-actions"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    (
      ({
        idle: "Copy Markdown",
        copied: "Copied",
        failed: "Copy failed",
        view: "View Markdown",
      }) as Record<string, string>
    )[key] ?? key,
}))

describe("PageActions", () => {
  it("renders next-intl copy and the Markdown twin link", () => {
    render(<PageActions markdownHref="/md/en/getting-started.md" />)

    expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "View Markdown" })).toHaveAttribute(
      "href",
      "/md/en/getting-started.md"
    )
  })
})
