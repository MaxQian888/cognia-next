/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}))

const setMobileRuntimeMode = jest.fn(async (_mode: "standalone" | "paired"): Promise<void> => undefined)
jest.mock("@/lib/runtime/standalone-mode", () => ({
  setMobileRuntimeMode: (mode: "standalone" | "paired") => setMobileRuntimeMode(mode),
}))

import { ModeChooser } from "./mode-chooser"

beforeEach(() => jest.clearAllMocks())

describe("ModeChooser", () => {
  it("standalone choice persists the mode and routes to BYOK key entry", async () => {
    render(<ModeChooser />)
    fireEvent.click(screen.getByTestId("welcome-standalone"))
    await waitFor(() => expect(setMobileRuntimeMode).toHaveBeenCalledWith("standalone"))
    expect(replace).toHaveBeenCalledWith("/me/providers")
  })

  it("pair choice persists the mode and routes to the pair flow", async () => {
    render(<ModeChooser />)
    fireEvent.click(screen.getByTestId("welcome-pair"))
    await waitFor(() => expect(setMobileRuntimeMode).toHaveBeenCalledWith("paired"))
    expect(replace).toHaveBeenCalledWith("/pair")
  })

  it("ignores a second click while a choice is in flight", async () => {
    render(<ModeChooser />)
    const btn = screen.getByTestId("welcome-standalone")
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => expect(setMobileRuntimeMode).toHaveBeenCalledTimes(1))
  })
})
