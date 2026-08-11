import { render, screen, fireEvent } from "@testing-library/react"

import { PetWalletStrip } from "./pet-wallet-strip"

describe("PetWalletStrip", () => {
  it("renders the normalized balance and hides streak/multiplier at zero days", () => {
    render(<PetWalletStrip coins={30} />)
    expect(screen.getByTestId("pet-wallet-balance").textContent).toContain("30")
    expect(screen.queryByTestId("pet-wallet-streak")).toBeNull()
    expect(screen.queryByTestId("pet-wallet-multiplier")).toBeNull()
  })

  it("treats missing coins as zero (legacy profiles predate the economy)", () => {
    render(<PetWalletStrip />)
    expect(screen.getByTestId("pet-wallet-balance").textContent).toContain("0")
  })

  it("shows the streak chip and the coin multiplier once the streak earns one", () => {
    render(<PetWalletStrip coins={10} streak={{ days: 7, lastDay: "2026-07-03" }} />)
    expect(screen.getByTestId("pet-wallet-streak").textContent).toContain("7")
    expect(screen.getByTestId("pet-wallet-multiplier").textContent).toContain("1.5")
  })

  it("hides the multiplier below the first tier (< 3 days)", () => {
    render(<PetWalletStrip coins={10} streak={{ days: 2, lastDay: "2026-07-03" }} />)
    expect(screen.getByTestId("pet-wallet-streak")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-wallet-multiplier")).toBeNull()
  })

  it("becomes a shop-jump button when onOpenShop is given", () => {
    const onOpenShop = jest.fn()
    render(<PetWalletStrip coins={5} onOpenShop={onOpenShop} />)
    const strip = screen.getByTestId("pet-wallet-strip")
    expect(strip.tagName).toBe("BUTTON")
    fireEvent.click(strip)
    expect(onOpenShop).toHaveBeenCalledTimes(1)
  })

  it("renders a plain div without onOpenShop", () => {
    render(<PetWalletStrip coins={5} />)
    expect(screen.getByTestId("pet-wallet-strip").tagName).toBe("DIV")
  })

  it("uses the flat variant without outlined chrome", () => {
    render(<PetWalletStrip coins={5} variant="flat" />)
    expect(screen.getByTestId("pet-wallet-strip")).toHaveAttribute("data-variant", "flat")
    expect(screen.getByTestId("pet-wallet-strip")).not.toHaveClass("border")
  })
})
