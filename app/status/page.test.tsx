/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("@/components/status/public-status-page", () => ({
  PublicStatusPage: () => <main data-testid="public-status-page" />,
}))

jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) =>
    ({
      title: "Cognia Relay Status",
      description:
        "Live availability, incidents and maintenance for the official Cognia signaling relay.",
    })[key],
}))

import StatusPage, { generateMetadata } from "./page"

describe("status route", () => {
  it("exports dedicated public metadata", async () => {
    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Cognia Relay Status",
      description:
        "Live availability, incidents and maintenance for the official Cognia signaling relay.",
    })
  })

  it("hosts the interactive public status experience", () => {
    render(<StatusPage />)
    expect(screen.getByTestId("public-status-page")).toBeInTheDocument()
  })
})
