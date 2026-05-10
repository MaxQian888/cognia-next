/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { QuickToggles } from "./quick-toggles"

const setThemeMock = jest.fn()
const themeRef = { value: "system" as string }
jest.mock("next-themes", () => {
  const React = jest.requireActual("react") as typeof import("react")
  return {
    useTheme: () => {
      const [theme, setTheme] = React.useState(themeRef.value)
      return {
        theme,
        setTheme: (v: string) => {
          themeRef.value = v
          setThemeMock(v)
          setTheme(v)
        },
      }
    },
  }
})

const setLanguageMock: jest.Mock<Promise<void>, [string]> = jest.fn()
const languageRef = { value: "en" as "en" | "zh-CN" }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: { language: string; setLanguage: (l: string) => Promise<void> }) => unknown
  ) =>
    selector({
      language: languageRef.value,
      setLanguage: async (l: string) => {
        languageRef.value = l as "en" | "zh-CN"
        await setLanguageMock(l)
      },
    }),
}))

const selectionFeedbackMock = jest.fn(async () => ({ kind: "ok" }))
jest.mock("@/lib/capacitor/haptics", () => ({
  selectionFeedback: () => selectionFeedbackMock(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      themeAuto: "Auto",
      themeLight: "Light",
      themeDark: "Dark",
      themeAria: "Cycle theme",
      languageAria: "Cycle language",
    }
    return map[key] ?? key
  },
}))

beforeEach(() => {
  setThemeMock.mockReset()
  setLanguageMock.mockReset()
  setLanguageMock.mockResolvedValue(undefined)
  themeRef.value = "system"
  languageRef.value = "en"
})

describe("<QuickToggles />", () => {
  it("renders theme + language pills with current values", () => {
    render(<QuickToggles />)
    expect(screen.getByTestId("quick-theme-toggle")).toHaveAttribute("data-theme", "system")
    expect(screen.getByTestId("quick-theme-toggle")).toHaveTextContent("Auto")
    expect(screen.getByTestId("quick-language-toggle")).toHaveAttribute("data-language", "en")
    expect(screen.getByTestId("quick-language-toggle")).toHaveTextContent("EN")
  })

  it("cycles theme system → light → dark → system", async () => {
    const user = userEvent.setup()
    render(<QuickToggles />)
    await user.click(screen.getByTestId("quick-theme-toggle"))
    expect(setThemeMock).toHaveBeenLastCalledWith("light")
    await user.click(screen.getByTestId("quick-theme-toggle"))
    expect(setThemeMock).toHaveBeenLastCalledWith("dark")
    await user.click(screen.getByTestId("quick-theme-toggle"))
    expect(setThemeMock).toHaveBeenLastCalledWith("system")
  })

  it("cycles language en ↔ zh-CN and triggers haptic feedback", async () => {
    const user = userEvent.setup()
    render(<QuickToggles />)
    await user.click(screen.getByTestId("quick-language-toggle"))
    expect(setLanguageMock).toHaveBeenLastCalledWith("zh-CN")
    expect(selectionFeedbackMock).toHaveBeenCalled()
  })
})
