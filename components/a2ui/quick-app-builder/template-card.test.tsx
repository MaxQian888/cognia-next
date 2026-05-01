/**
 * Tests for TemplateCard
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { TemplateCard } from "./template-card"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"

const mockResolveIcon = jest.fn()

jest.mock("@/lib/a2ui/resolve-icon", () => ({
  resolveIcon: (iconName?: string) => mockResolveIcon(iconName),
}))

jest.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
    className?: string
  }) => (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <div data-testid="template-card" className={className} onClick={onClick}>
      {children}
    </div>
  ),
  CardHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="template-card-footer" className={className}>
      {children}
    </div>
  ),
  CardTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h3 className={className}>{children}</h3>
  ),
  CardDescription: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

jest.mock("lucide-react", () => ({
  Plus: ({ className }: { className?: string }) => (
    <span data-testid="plus-icon" className={className}>
      plus
    </span>
  ),
  Sparkles: ({ className }: { className?: string }) => (
    <span data-testid="sparkles-icon" className={className}>
      sparkles
    </span>
  ),
}))

const ResolvedIcon = ({ className }: { className?: string }) => (
  <span data-testid="resolved-icon" className={className}>
    resolved
  </span>
)

const template: A2UIAppTemplate = {
  id: "template-1",
  name: "Template Alpha",
  description: "Template description",
  icon: "Calculator",
  category: "utility",
  components: [],
  dataModel: {},
  tags: ["tag-1", "tag-2", "tag-3", "tag-4"],
}

describe("TemplateCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveIcon.mockReturnValue(ResolvedIcon)
  })

  it("renders template content in grid mode and limits tags to first three", () => {
    render(<TemplateCard template={template} viewMode="grid" onSelect={jest.fn()} />)

    expect(screen.getByText("Template Alpha")).toBeInTheDocument()
    expect(screen.getByText("Template description")).toBeInTheDocument()
    expect(screen.getByTestId("resolved-icon")).toBeInTheDocument()
    expect(screen.getByText("tag-1")).toBeInTheDocument()
    expect(screen.getByText("tag-2")).toBeInTheDocument()
    expect(screen.getByText("tag-3")).toBeInTheDocument()
    expect(screen.queryByText("tag-4")).not.toBeInTheDocument()
    expect(screen.queryByText("Create")).not.toBeInTheDocument()
  })

  it("calls onSelect when card is clicked", () => {
    const onSelect = jest.fn()
    render(<TemplateCard template={template} viewMode="grid" onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId("template-card"))
    expect(onSelect).toHaveBeenCalledWith(template)
  })

  it("renders list mode action button and calls onSelect once on Create click", () => {
    const onSelect = jest.fn()
    render(<TemplateCard template={template} viewMode="list" onSelect={onSelect} />)

    const createButton = screen.getByRole("button", { name: /Create/i })
    fireEvent.click(createButton)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(template)
    expect(screen.getByTestId("plus-icon")).toBeInTheDocument()
  })

  it("falls back to Sparkles icon when resolveIcon returns null", () => {
    mockResolveIcon.mockReturnValueOnce(null)
    render(<TemplateCard template={template} viewMode="grid" onSelect={jest.fn()} />)

    expect(screen.getByTestId("sparkles-icon")).toBeInTheDocument()
  })
})
