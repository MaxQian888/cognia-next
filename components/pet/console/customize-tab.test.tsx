import { render, screen } from "@testing-library/react"

jest.mock("@/components/pet/settings/pet-customization-workspace", () => ({
  PetCustomizationWorkspace: () => <div data-testid="pet-customization-workspace" />,
}))

import { CustomizeTab } from "./customize-tab"

describe("CustomizeTab", () => {
  it("renders the complete shared customization workspace", () => {
    render(<CustomizeTab />)
    expect(screen.getByTestId("pet-customization-workspace")).toBeInTheDocument()
  })
})
