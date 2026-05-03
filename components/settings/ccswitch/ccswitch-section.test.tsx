/**
 * @jest-environment jsdom
 */

// Mock Next router so the URL-param round-trip can be observed.
const replaceMock = jest.fn()
let searchParams = new URLSearchParams()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => searchParams,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub each tab so the shell renders without dragging in IPC / Dexie.
jest.mock("./tabs", () => ({
  CcswitchOverviewTab: () => <div data-testid="overview-tab">overview</div>,
  CcswitchProvidersTab: () => <div data-testid="providers-tab">providers</div>,
  CcswitchMcpTab: () => <div data-testid="mcp-tab">mcp</div>,
  CcswitchPromptsTab: () => <div data-testid="prompts-tab">prompts</div>,
  CcswitchSkillsTab: () => <div data-testid="skills-tab">skills</div>,
  CcswitchSyncTab: () => <div data-testid="sync-tab">sync</div>,
}))

import { render, screen, fireEvent } from "@testing-library/react"

import { CcswitchSection } from "./ccswitch-section"

beforeEach(() => {
  jest.resetAllMocks()
  searchParams = new URLSearchParams()
})

describe("CcswitchSection", () => {
  it("defaults to the overview tab", () => {
    render(<CcswitchSection />)
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()
  })

  it("respects ?ccswitchTab= deep links", () => {
    searchParams = new URLSearchParams("ccswitchTab=providers")
    render(<CcswitchSection />)
    expect(screen.getByTestId("providers-tab")).toBeInTheDocument()
  })

  it("falls back to overview when the URL param is unrecognized", () => {
    searchParams = new URLSearchParams("ccswitchTab=garbage")
    render(<CcswitchSection />)
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()
  })

  it("clicking a tab trigger updates ?ccswitchTab=", () => {
    render(<CcswitchSection />)
    const trigger = screen.getByRole("tab", { name: "tabs.providers" })
    // Radix Tabs needs the full pointer-down → click sequence to fire
    // `onValueChange`; a bare click event in jsdom is otherwise swallowed
    // by the keyboard-focus pathway.
    fireEvent.pointerDown(trigger, { pointerType: "mouse" })
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    expect(replaceMock).toHaveBeenCalled()
    const url = replaceMock.mock.calls.at(-1)![0] as string
    expect(url).toContain("ccswitchTab=providers")
  })

  it("renders all six tab triggers", () => {
    render(<CcswitchSection />)
    for (const id of ["overview", "providers", "mcp", "prompts", "skills", "sync"]) {
      expect(screen.getByRole("tab", { name: `tabs.${id}` })).toBeInTheDocument()
    }
  })
})
