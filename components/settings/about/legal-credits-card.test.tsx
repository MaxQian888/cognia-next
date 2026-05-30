/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const openExternalMock = jest.fn(async (_u: string) => {})
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (u: string) => openExternalMock(u) }))

import { LegalCreditsCard } from "./legal-credits-card"
import { LICENSE_URL, PRIVACY_URL } from "@/lib/constants/external-urls"

describe("<LegalCreditsCard />", () => {
  it("renders a copyright range with the holder", () => {
    render(<LegalCreditsCard currentYear={2027} />)
    const line = screen.getByTestId("copyright-line")
    expect(line).toHaveTextContent("2025–2027")
    expect(line).toHaveTextContent("AstroAir")
  })

  it("shows a single year when current equals the start year", () => {
    render(<LegalCreditsCard currentYear={2025} />)
    expect(screen.getByTestId("copyright-line")).toHaveTextContent("2025")
    expect(screen.getByTestId("copyright-line")).not.toHaveTextContent("–")
  })

  it("links to license and privacy", () => {
    render(<LegalCreditsCard currentYear={2026} />)
    fireEvent.click(screen.getByTestId("view-license"))
    expect(openExternalMock).toHaveBeenCalledWith(LICENSE_URL)
    fireEvent.click(screen.getByTestId("view-privacy"))
    expect(openExternalMock).toHaveBeenCalledWith(PRIVACY_URL)
  })

  it("renders open-source acknowledgements that open on click", () => {
    render(<LegalCreditsCard currentYear={2026} />)
    const acks = screen.getByTestId("acknowledgements")
    expect(acks).toHaveTextContent("Next.js")
    expect(acks).toHaveTextContent("Tauri")
    fireEvent.click(screen.getByText("React"))
    expect(openExternalMock).toHaveBeenCalledWith("https://react.dev")
  })
})
