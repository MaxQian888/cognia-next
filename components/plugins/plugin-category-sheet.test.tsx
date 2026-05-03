/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub the inner sidebar so we don't drag in usePlugins / dexie / store wiring.
jest.mock("./plugin-category-sidebar", () => ({
  PluginCategorySidebar: () => (
    <div data-testid="plugin-category-sidebar">
      <button>fake-category</button>
    </div>
  ),
}))

// Radix Sheet uses pointer events that fireEvent.click does not drive — render
// content unconditionally so the inner sidebar is always reachable.
jest.mock("@/components/ui/sheet", () => {
  return {
    Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SheetTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? <>{children}</> : <button>{children}</button>,
    SheetContent: ({
      children,
      className,
      onClick,
    }: {
      children: React.ReactNode
      className?: string
      onClick?: (e: React.MouseEvent) => void
    }) => (
      <div data-testid="sheet-content" className={className} onClick={onClick}>
        {children}
      </div>
    ),
    SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  }
})

import { PluginCategorySheet } from "./plugin-category-sheet"

describe("PluginCategorySheet", () => {
  it("renders trigger button with label and applies className", () => {
    render(<PluginCategorySheet className="lg:hidden" />)
    const trigger = screen.getByRole("button", { name: "categoriesButton" })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveClass("lg:hidden")
  })

  it("renders the inner sidebar inside SheetContent", () => {
    render(<PluginCategorySheet />)
    expect(screen.getByTestId("plugin-category-sidebar")).toBeInTheDocument()
    expect(screen.getByText("fake-category")).toBeInTheDocument()
  })

  it("clicking inside the SheetContent on a button does not throw", () => {
    render(<PluginCategorySheet />)
    expect(() => fireEvent.click(screen.getByText("fake-category"))).not.toThrow()
  })
})
