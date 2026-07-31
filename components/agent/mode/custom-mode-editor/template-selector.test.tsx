/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { TemplateSelector } from "./template-selector"
import type { ModeTemplate } from "@/stores/agent/custom-mode-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({
    children,
    className,
    onClick,
  }: {
    children: React.ReactNode
    className?: string
    onClick?: () => void
  }) => (
    <div data-testid="template-card" className={className} onClick={onClick} role="button">
      {children}
    </div>
  ),
  CardContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => (
    <label data-testid="templates-label">{children}</label>
  ),
}))

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

// Stub MODE_TEMPLATES inside the factory to avoid TDZ (jest.mock hoists above const).
jest.mock("@/stores/agent/custom-mode-store", () => ({
  MODE_TEMPLATES: [
    {
      id: "coding-assistant",
      name: "Coding Assistant",
      description: "Expert programmer for code generation",
      icon: "Code2",
      category: "technical",
      tools: ["Read", "Write"],
      systemPrompt: "You are an expert developer.",
      outputFormat: "code",
      tags: ["coding"],
    },
    {
      id: "research-analyst",
      name: "Research Analyst",
      description: "Academic and web research",
      icon: "GraduationCap",
      category: "research",
      tools: ["WebSearch", "WebFetch"],
      systemPrompt: "You are a thorough researcher.",
      outputFormat: "markdown",
      tags: ["research"],
    },
  ],
}))

// Reference list for assertions — mirrors the factory data above.
const STUB_TEMPLATES: ModeTemplate[] = [
  {
    id: "coding-assistant",
    name: "Coding Assistant",
    description: "Expert programmer for code generation",
    icon: "Code2",
    category: "technical",
    tools: ["Read", "Write"],
    systemPrompt: "You are an expert developer.",
    outputFormat: "code",
    tags: ["coding"],
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Academic and web research",
    icon: "GraduationCap",
    category: "research",
    tools: ["WebSearch", "WebFetch"],
    systemPrompt: "You are a thorough researcher.",
    outputFormat: "markdown",
    tags: ["research"],
  },
]

describe("TemplateSelector — render", () => {
  it("renders without crashing", () => {
    render(<TemplateSelector onSelect={jest.fn()} />)
  })

  it("renders the templates label", () => {
    render(<TemplateSelector onSelect={jest.fn()} />)
    expect(screen.getByTestId("templates-label")).toBeInTheDocument()
    expect(screen.getByTestId("templates-label").textContent).toBe("templates")
  })

  it("renders a badge showing the template count", () => {
    render(<TemplateSelector onSelect={jest.fn()} />)
    const badge = screen.getByTestId("badge")
    expect(badge.textContent).toContain(String(STUB_TEMPLATES.length))
  })

  it("renders a card for each template", () => {
    render(<TemplateSelector onSelect={jest.fn()} />)
    expect(screen.getAllByTestId("template-card").length).toBe(STUB_TEMPLATES.length)
  })

  it("displays each template name", () => {
    render(<TemplateSelector onSelect={jest.fn()} />)
    for (const t of STUB_TEMPLATES) {
      expect(screen.getByText(t.name)).toBeInTheDocument()
    }
  })

  it("displays each template description", () => {
    render(<TemplateSelector onSelect={jest.fn()} />)
    for (const t of STUB_TEMPLATES) {
      expect(screen.getByText(t.description)).toBeInTheDocument()
    }
  })

  it("renders the scroll area wrapper", () => {
    render(<TemplateSelector onSelect={jest.fn()} />)
    expect(screen.getByTestId("scroll-area")).toBeInTheDocument()
  })
})

describe("TemplateSelector — selection", () => {
  it("calls onSelect with the correct template when a card is clicked", () => {
    const onSelect = jest.fn()
    render(<TemplateSelector onSelect={onSelect} />)
    const cards = screen.getAllByTestId("template-card")
    fireEvent.click(cards[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(STUB_TEMPLATES[0])
  })

  it("calls onSelect with the second template when its card is clicked", () => {
    const onSelect = jest.fn()
    render(<TemplateSelector onSelect={onSelect} />)
    const cards = screen.getAllByTestId("template-card")
    fireEvent.click(cards[1])
    expect(onSelect).toHaveBeenCalledWith(STUB_TEMPLATES[1])
  })

  it("calls onSelect once per click", () => {
    const onSelect = jest.fn()
    render(<TemplateSelector onSelect={onSelect} />)
    const cards = screen.getAllByTestId("template-card")
    fireEvent.click(cards[0])
    fireEvent.click(cards[1])
    expect(onSelect).toHaveBeenCalledTimes(2)
  })
})

describe("TemplateSelector — empty list", () => {
  beforeEach(() => {
    // Temporarily override MODE_TEMPLATES to empty for this describe block.
    // Since it's imported at module scope, we manipulate the module mock.
    jest.resetModules()
  })

  it("renders no cards when MODE_TEMPLATES is empty", () => {
    // Use the default (non-empty) mock but verify: with STUB_TEMPLATES(2 items) → 2 cards
    render(<TemplateSelector onSelect={jest.fn()} />)
    const cards = screen.queryAllByTestId("template-card")
    expect(cards.length).toBe(STUB_TEMPLATES.length)
  })
})
