/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { IconSelector } from "./icon-selector"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Expose CollapsibleContent immediately (no animation portal) so icon buttons
// are queryable without pointer-event tricks.
jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (v: boolean) => void
  }) => (
    <div data-testid="collapsible" data-open={open} onClick={() => onOpenChange?.(!open)}>
      {children}
    </div>
  ),
  CollapsibleTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    className,
    size,
  }: {
    children: React.ReactNode
    onClick?: () => void
    variant?: string
    className?: string
    size?: string
  }) => (
    <button data-variant={variant} data-size={size} className={className} onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
  }) => (
    <input data-testid="search-input" value={value} onChange={onChange} placeholder={placeholder} />
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => (
    <label data-testid="field-label">{children}</label>
  ),
}))

// Minimal icon library — only register the icons used in AVAILABLE_MODE_ICONS
// that the real `resolve-icon` module provides so tests don't need the full
// Lucide tree loaded.
jest.mock("@/lib/agent/resolve-icon", () => ({
  LucideIcons: new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        const Icon = ({ className }: { className?: string }) => (
          <svg data-testid={`icon-${prop}`} className={className} />
        )
        Icon.displayName = prop
        return Icon
      },
    }
  ),
}))

// Stub the AVAILABLE_MODE_ICONS constant to a small, predictable set.
jest.mock("@/stores/agent/custom-mode-store", () => ({
  AVAILABLE_MODE_ICONS: ["Bot", "Brain", "Rocket", "Star", "Code2"],
}))

describe("IconSelector — render", () => {
  it("renders without crashing", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
  })

  it("shows the label translation key", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    expect(screen.getByTestId("field-label")).toBeInTheDocument()
    expect(screen.getByTestId("field-label").textContent).toBe("icon")
  })

  it("displays the currently-selected icon name in the trigger", () => {
    render(<IconSelector value="Rocket" onChange={jest.fn()} />)
    expect(screen.getAllByText("Rocket").length).toBeGreaterThan(0)
  })

  it("shows all stubbed icons in the collapsible content", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    // The content is rendered inline by the mock.
    const content = screen.getByTestId("collapsible-content")
    expect(content).toBeInTheDocument()
    // All 5 stubbed icons are rendered as icon buttons.
    expect(content.querySelectorAll("button").length).toBe(5)
  })
})

describe("IconSelector — selection", () => {
  it("calls onChange with the clicked icon name", () => {
    const onChange = jest.fn()
    render(<IconSelector value="Bot" onChange={onChange} />)
    // Find the Rocket icon button inside the content.
    const content = screen.getByTestId("collapsible-content")
    const buttons = content.querySelectorAll("button")
    // Buttons are ordered by AVAILABLE_MODE_ICONS: Bot, Brain, Rocket, Star, Code2
    fireEvent.click(buttons[2]) // Rocket
    expect(onChange).toHaveBeenCalledWith("Rocket")
  })

  it("marks the selected icon with default variant", () => {
    render(<IconSelector value="Star" onChange={jest.fn()} />)
    const content = screen.getByTestId("collapsible-content")
    const buttons = Array.from(content.querySelectorAll("button"))
    const starButton = buttons[3] // Star is index 3
    expect(starButton.getAttribute("data-variant")).toBe("default")
  })

  it("marks non-selected icons with ghost variant", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    const content = screen.getByTestId("collapsible-content")
    const buttons = Array.from(content.querySelectorAll("button"))
    // Brain is not selected
    expect(buttons[1].getAttribute("data-variant")).toBe("ghost")
  })

  it("calls onChange only once per click", () => {
    const onChange = jest.fn()
    render(<IconSelector value="Bot" onChange={onChange} />)
    const content = screen.getByTestId("collapsible-content")
    const buttons = content.querySelectorAll("button")
    fireEvent.click(buttons[0])
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe("IconSelector — search filtering", () => {
  it("shows search input in the collapsible content", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    expect(screen.getByTestId("search-input")).toBeInTheDocument()
  })

  it("shows placeholder translation key on the search input", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    expect(screen.getByTestId("search-input").getAttribute("placeholder")).toBe("searchIcons")
  })

  it("filters icon buttons by search term", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    const searchInput = screen.getByTestId("search-input")
    fireEvent.change(searchInput, { target: { value: "bo" } })
    // Only "Bot" matches "bo"
    const content = screen.getByTestId("collapsible-content")
    expect(content.querySelectorAll("button").length).toBe(1)
  })

  it("shows zero icon buttons when search matches nothing", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    const searchInput = screen.getByTestId("search-input")
    fireEvent.change(searchInput, { target: { value: "xyz_no_match" } })
    const content = screen.getByTestId("collapsible-content")
    expect(content.querySelectorAll("button").length).toBe(0)
  })

  it("restores all icons when search is cleared", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    const searchInput = screen.getByTestId("search-input")
    fireEvent.change(searchInput, { target: { value: "Ro" } })
    fireEvent.change(searchInput, { target: { value: "" } })
    const content = screen.getByTestId("collapsible-content")
    expect(content.querySelectorAll("button").length).toBe(5)
  })

  it("search is case-insensitive", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    const searchInput = screen.getByTestId("search-input")
    fireEvent.change(searchInput, { target: { value: "ROCKET" } })
    const content = screen.getByTestId("collapsible-content")
    expect(content.querySelectorAll("button").length).toBe(1)
  })
})

describe("IconSelector — tooltip content", () => {
  it("renders icon name in tooltip for each icon", () => {
    render(<IconSelector value="Bot" onChange={jest.fn()} />)
    const tooltipContents = screen.getAllByTestId("tooltip-content")
    const names = tooltipContents.map((el) => el.textContent)
    expect(names).toContain("Bot")
    expect(names).toContain("Brain")
  })
})
