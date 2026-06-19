import { fireEvent, render, screen } from "@testing-library/react"
import { MonacoLinkCard } from "./monaco-link-card"
import { DEFAULT_MONACO_LINK } from "@/types/appearance"
import type { MonacoLinkSettings } from "@/types/appearance"

const mockSave = jest.fn()
let mockMonacoLink: MonacoLinkSettings = { ...DEFAULT_MONACO_LINK }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ monacoLink: mockMonacoLink, save: mockSave }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  return {
    Select: ({ value, onValueChange, children }: never) =>
      React.createElement(
        "select",
        {
          value,
          onChange: (e: never) =>
            (onValueChange as (v: string) => void)((e as never)["target"]["value"]),
        },
        children
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: never) => children,
    SelectItem: ({ value, children }: never) => React.createElement("option", { value }, children),
  }
})

beforeEach(() => {
  mockSave.mockClear()
  mockMonacoLink = { ...DEFAULT_MONACO_LINK }
})

describe("MonacoLinkCard", () => {
  it("toggles app-theme linking", () => {
    render(<MonacoLinkCard />)
    fireEvent.click(screen.getByRole("switch", { name: "enabledLabel" }))
    // DEFAULT_MONACO_LINK.enabled is true, so toggling sends false.
    expect(mockSave).toHaveBeenCalledWith({
      monacoLink: expect.objectContaining({ enabled: false }),
    })
  })

  it("pins a locked theme", () => {
    render(<MonacoLinkCard />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "vs-dark" } })
    expect(mockSave).toHaveBeenCalledWith({
      monacoLink: expect.objectContaining({ lockedThemeId: "vs-dark" }),
    })
  })

  it("clears the lock when 'none' is chosen", () => {
    mockMonacoLink = { enabled: true, lockedThemeId: "vs-dark" }
    render(<MonacoLinkCard />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "__none__" } })
    expect(mockSave).toHaveBeenCalledWith({
      monacoLink: expect.objectContaining({ lockedThemeId: undefined }),
    })
  })
})
