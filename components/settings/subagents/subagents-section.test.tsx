/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { SubagentsSection } from "./subagents-section"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const replaceMock = jest.fn()
let searchString = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchString),
}))

// Stub Tabs primitives so click flips the active tab in jsdom.
jest.mock("@/components/ui/tabs", () => {
  const TabsContext = React.createContext<{
    value?: string
    onValueChange?: (v: string) => void
  }>({})
  const Tabs = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children: React.ReactNode
  }) => <TabsContext.Provider value={{ value, onValueChange }}>{children}</TabsContext.Provider>
  const TabsList = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  const TabsTrigger = ({
    value,
    children,
    ...rest
  }: {
    value: string
    children: React.ReactNode
  } & Record<string, unknown>) => {
    const ctx = React.useContext(TabsContext)
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)} {...rest}>
        {children}
      </button>
    )
  }
  return { Tabs, TabsList, TabsTrigger }
})

// Children are tested in their own files; stub them here so the section's
// own behavior (URL-driven tab) is the only thing under test.
jest.mock("./subagent-templates-tab", () => ({
  SubagentTemplatesTab: () => <div data-testid="stub-templates-tab">templates</div>,
}))
jest.mock("./subagent-runtime-tab", () => ({
  SubagentRuntimeTab: () => <div data-testid="stub-runtime-tab">runtime</div>,
}))

beforeEach(() => {
  searchString = ""
  replaceMock.mockReset()
})

describe("SubagentsSection", () => {
  it("defaults to the templates tab", () => {
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-templates-tab")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-runtime-tab")).not.toBeInTheDocument()
  })

  it("respects ?subagentTab=runtime", () => {
    searchString = "subagentTab=runtime"
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-runtime-tab")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-templates-tab")).not.toBeInTheDocument()
  })

  it("clicking the runtime tab updates the URL", () => {
    render(<SubagentsSection />)
    fireEvent.click(screen.getByTestId("subagent-tab-runtime"))
    expect(replaceMock).toHaveBeenCalled()
    const arg = replaceMock.mock.calls[0][0] as string
    expect(arg).toContain("subagentTab=runtime")
  })

  it("clicking the templates tab updates the URL too", () => {
    searchString = "subagentTab=runtime"
    render(<SubagentsSection />)
    fireEvent.click(screen.getByTestId("subagent-tab-templates"))
    expect(replaceMock).toHaveBeenCalled()
    const arg = replaceMock.mock.calls[0][0] as string
    expect(arg).toContain("subagentTab=templates")
  })
})
