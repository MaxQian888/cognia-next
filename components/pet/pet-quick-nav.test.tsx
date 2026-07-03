import { render, screen, fireEvent } from "@testing-library/react"

import { PetQuickNav } from "./pet-quick-nav"

describe("PetQuickNav", () => {
  it("renders the five console shortcuts with visible labels", () => {
    render(<PetQuickNav onNavigate={jest.fn()} />)
    for (const tab of ["shop", "customize", "insights", "dex", "achievements"]) {
      expect(document.querySelector(`[data-nav="${tab}"]`)).not.toBeNull()
    }
    expect(screen.getByLabelText("Shop")).toHaveTextContent("Shop")
  })

  it("forwards each tab to onNavigate", () => {
    const onNavigate = jest.fn()
    render(<PetQuickNav onNavigate={onNavigate} />)
    fireEvent.click(document.querySelector('[data-nav="shop"]') as Element)
    expect(onNavigate).toHaveBeenCalledWith("shop")
    fireEvent.click(document.querySelector('[data-nav="achievements"]') as Element)
    expect(onNavigate).toHaveBeenCalledWith("achievements")
  })
})
