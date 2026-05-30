/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

const isTauriMock = jest.fn<boolean, []>(() => false)
const isCapacitorMock = jest.fn<boolean, []>(() => false)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  isCapacitor: () => isCapacitorMock(),
}))

const getAppNameMock = jest.fn(async () => "Cognia")
const getReleaseChannelMock = jest.fn(() => "stable")
jest.mock("@/lib/app-metadata", () => ({
  APP_NAME: "Cognia",
  APP_VERSION: "9.9.9",
  getAppName: () => getAppNameMock(),
  getReleaseChannel: () => getReleaseChannelMock(),
}))

import { AboutHero } from "./about-hero"

beforeEach(() => {
  isTauriMock.mockReturnValue(false)
  isCapacitorMock.mockReturnValue(false)
  getReleaseChannelMock.mockReturnValue("stable")
  getAppNameMock.mockResolvedValue("Cognia")
})

describe("<AboutHero />", () => {
  it("renders the icon, version and resolved name", async () => {
    render(<AboutHero />)
    const hero = screen.getByTestId("about-hero")
    expect(hero).toHaveTextContent("9.9.9")
    expect(screen.getByRole("img")).toHaveAttribute("src", "/icons/icon-512.png")
    await waitFor(() => expect(hero).toHaveTextContent("Cognia"))
  })

  it("shows the web-preview badge in the browser shell", () => {
    render(<AboutHero />)
    expect(screen.getByTestId("about-web-badge")).toBeInTheDocument()
  })

  it("hides the web-preview badge on desktop", () => {
    isTauriMock.mockReturnValue(true)
    render(<AboutHero />)
    expect(screen.queryByTestId("about-web-badge")).not.toBeInTheDocument()
  })

  it("renders the dev channel label", () => {
    getReleaseChannelMock.mockReturnValue("dev")
    render(<AboutHero />)
    expect(screen.getByTestId("about-hero")).toHaveTextContent("Dev")
  })
})
