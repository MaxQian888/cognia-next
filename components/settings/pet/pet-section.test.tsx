import { render, screen } from "@testing-library/react"

jest.mock("@/components/pet/settings/pet-customization-workspace", () => ({
  PetCustomizationWorkspace: () => <div data-testid="pet-customization-workspace" />,
}))

import { PetSection } from "./pet-section"

describe("PetSection", () => {
  it("renders the complete shared customization workspace", () => {
    render(<PetSection />)
    expect(screen.getByTestId("pet-customization-workspace")).toBeInTheDocument()
  })
})
