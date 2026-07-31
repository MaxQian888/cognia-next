/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("@/components/pet/pet-overlay-view", () => ({
  PetOverlayView: () => <div data-testid="pet-overlay-view" />,
}))

import PetOverlayPage from "./page"

describe("PetOverlayPage", () => {
  it("renders the PetOverlayView", () => {
    render(<PetOverlayPage />)
    expect(screen.getByTestId("pet-overlay-view")).toBeInTheDocument()
  })
})
