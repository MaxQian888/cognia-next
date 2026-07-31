/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const petRef = { minimized: false }
const setMinimized = jest.fn()
jest.mock("@/stores/pet/pet-store", () => ({
  usePetStore: (selector: (s: { minimized: boolean; setMinimized: jest.Mock }) => unknown) =>
    selector({ minimized: petRef.minimized, setMinimized }),
}))

const requestOpenSettings = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: { requestOpenSettings: jest.Mock }) => unknown) =>
    selector({ requestOpenSettings }),
}))

import { TitleBarQuickActions } from "./title-bar-quick-actions"

beforeEach(() => {
  petRef.minimized = false
  setMinimized.mockClear()
  requestOpenSettings.mockClear()
})

describe("TitleBarQuickActions", () => {
  it("toggles the pet from visible to hidden", () => {
    render(<TitleBarQuickActions />)
    const pet = screen.getByTestId("quick-action-pet")
    expect(pet).toHaveAttribute("aria-pressed", "true")
    expect(pet).toHaveAttribute("aria-label", "hidePet")
    fireEvent.click(pet)
    expect(setMinimized).toHaveBeenCalledWith(true)
  })

  it("toggles the pet from hidden to visible", () => {
    petRef.minimized = true
    render(<TitleBarQuickActions />)
    const pet = screen.getByTestId("quick-action-pet")
    expect(pet).toHaveAttribute("aria-pressed", "false")
    expect(pet).toHaveAttribute("aria-label", "showPet")
    fireEvent.click(pet)
    expect(setMinimized).toHaveBeenCalledWith(false)
  })

  it("opens OCR settings", () => {
    render(<TitleBarQuickActions />)
    fireEvent.click(screen.getByTestId("quick-action-ocr"))
    expect(requestOpenSettings).toHaveBeenCalledWith("ocr")
  })

  it("opens the capture settings (pet console) section", () => {
    render(<TitleBarQuickActions />)
    fireEvent.click(screen.getByTestId("quick-action-capture"))
    expect(requestOpenSettings).toHaveBeenCalledWith("pet")
  })
})
