/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

const save = jest.fn().mockResolvedValue(undefined)
const storeState: { settings: Record<string, unknown> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

import { AppearanceConfigToolbar } from "./appearance-config-toolbar"

beforeEach(() => {
  save.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  storeState.settings = { theme: "dark", colorTheme: "ocean" }
  ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = jest.fn(() => "blob:x")
  ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn()
  // The download path calls anchor.click(); jsdom would attempt a real
  // navigation (a noisy "not implemented" log). Stub it to a no-op.
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

/** A File whose `.text()` deterministically resolves to `content`. */
function jsonFile(content: string): File {
  const file = new File([content], "look.json", { type: "application/json" })
  Object.defineProperty(file, "text", { value: () => Promise.resolve(content) })
  return file
}

describe("AppearanceConfigToolbar", () => {
  it("exports the current appearance as a downloadable file", () => {
    render(<AppearanceConfigToolbar />)
    fireEvent.click(screen.getByRole("button", { name: "export" }))
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("opens a confirm dialog for a valid import, then applies it", async () => {
    render(<AppearanceConfigToolbar />)
    const file = jsonFile(
      JSON.stringify({ formatVersion: "v1", settings: { theme: "light", radius: { base: 1 } } })
    )
    fireEvent.change(screen.getByTestId("appearance-import-input"), { target: { files: [file] } })
    const confirmBtn = await screen.findByRole("button", { name: "confirm.confirm" })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(save).toHaveBeenCalledWith({ theme: "light", radius: { base: 1 } }))
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("shows an error toast for an invalid import and opens no dialog", async () => {
    render(<AppearanceConfigToolbar />)
    fireEvent.change(screen.getByTestId("appearance-import-input"), {
      target: { files: [jsonFile("{ not json")] },
    })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.queryByText("confirm.title")).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })
})
