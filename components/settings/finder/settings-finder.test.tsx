/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const replaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams("section=general"),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// One control with keywords, one without — exercises the optional-keywords path.
// The third targets a section a web-standalone client cannot reach (the
// `desktop` section is pinned to the desktop profile), which the finder must
// hide there (the registry really does contain such controls: tools, sandbox).
jest.mock("./control-registry", () => ({
  SETTING_CONTROLS: [
    {
      id: "default-model",
      sectionId: "agent-runtime",
      labelKey: "defaultModel",
      keywords: ["model"],
    },
    { id: "no-keywords", sectionId: "about", labelKey: "autoUpdate" },
    { id: "desktop-bound", sectionId: "desktop", labelKey: "secretStore" },
  ],
}))

import { SettingsFinder } from "./settings-finder"

const TAURI_MARKER = "__TAURI_INTERNALS__"
function setDesktop(on: boolean) {
  if (on) {
    ;(window as unknown as Record<string, unknown>)[TAURI_MARKER] = {}
  } else {
    delete (window as unknown as Record<string, unknown>)[TAURI_MARKER]
  }
}

beforeEach(() => {
  replaceMock.mockClear()
})

afterEach(() => setDesktop(false))

describe("SettingsFinder", () => {
  it("lists control and section entries when open", () => {
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    expect(screen.getAllByTestId("finder-control").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("finder-section").length).toBeGreaterThan(0)
  })

  it("navigates to section + focus when a control is chosen", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(<SettingsFinder open onOpenChange={onOpenChange} />)
    await user.click(screen.getAllByTestId("finder-control")[0])
    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1))
    const url = replaceMock.mock.calls[0][0] as string
    expect(url).toContain("section=")
    expect(url).toContain("focus=")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("navigates to a bare section (no focus) when a section is chosen", async () => {
    const user = userEvent.setup()
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    await user.click(screen.getAllByTestId("finder-section")[0])
    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1))
    const url = replaceMock.mock.calls[0][0] as string
    expect(url).toContain("section=")
    expect(url).not.toContain("focus=")
  })
})

// The sidebar has always hidden desktop-only sections in web mode; the finder
// did not, which made ⌘K the back door into panels whose IPC can only reject.
describe("SettingsFinder host-reachability filtering", () => {
  it("hides sections a web-standalone client cannot reach", () => {
    setDesktop(false)
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    expect(screen.queryByText("tabs.subscription")).not.toBeInTheDocument()
    expect(screen.queryByText("tabs.ccswitch")).not.toBeInTheDocument()
    expect(screen.queryByText("tabs.desktop")).not.toBeInTheDocument()
  })

  it("hides controls that deep-link into an unreachable section", () => {
    setDesktop(false)
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    expect(screen.queryByText("finder.controls.secretStore")).not.toBeInTheDocument()
  })

  it("keeps browser-capable sections and controls listed in web mode", () => {
    setDesktop(false)
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    expect(screen.getByText("tabs.appearance")).toBeInTheDocument()
    expect(screen.getByText("finder.controls.defaultModel")).toBeInTheDocument()
  })

  it("lists everything on desktop", () => {
    setDesktop(true)
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    expect(screen.getByText("tabs.subscription")).toBeInTheDocument()
    expect(screen.getByText("tabs.ccswitch")).toBeInTheDocument()
    expect(screen.getByText("finder.controls.secretStore")).toBeInTheDocument()
  })
})
