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

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))

let mockPlatform: "tauri" | "web" | "mobile" = "tauri"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))

let mockPetEnabled = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { petSettings: { enabled: mockPetEnabled } } }),
}))

import { TitleBarQuickActions } from "./title-bar-quick-actions"

beforeEach(() => {
  petRef.minimized = false
  setMinimized.mockClear()
  requestOpenSettings.mockClear()
  routerPush.mockClear()
  mockPlatform = "tauri"
  mockPetEnabled = true
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

  it("opens the capture settings where they live: the pet console's Insights tab", () => {
    // Settings → Pet has no capture controls; `CaptureSettingsPanel` is mounted
    // only in the console's Insights tab.
    render(<TitleBarQuickActions />)
    fireEvent.click(screen.getByTestId("quick-action-capture"))
    expect(routerPush).toHaveBeenCalledWith("/pet?tab=insights")
    expect(requestOpenSettings).not.toHaveBeenCalled()
  })

  it("does not offer a pet toggle for a pet that is switched off", () => {
    mockPetEnabled = false
    render(<TitleBarQuickActions />)
    expect(screen.queryByTestId("quick-action-pet")).toBeNull()
    expect(screen.getByTestId("quick-action-capture")).toBeInTheDocument()
  })

  it.each(["web", "mobile"] as const)(
    "keeps only OCR on %s, where the pet and its console cannot run (ADR-0058 D9)",
    (platform) => {
      mockPlatform = platform
      render(<TitleBarQuickActions />)
      expect(screen.queryByTestId("quick-action-pet")).toBeNull()
      expect(screen.queryByTestId("quick-action-capture")).toBeNull()
      expect(screen.getByTestId("quick-action-ocr")).toBeInTheDocument()
    }
  )
})
