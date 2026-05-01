/**
 * Tests for QuickAppCard
 */

import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QuickAppCard } from "./app-card"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"
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
    title,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
    title?: string
    disabled?: boolean
  }) => (
    <button type="button" className={className} title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="quick-app-card" className={className}>
      {children}
    </div>
  ),
  CardHeader: ({
    children,
    className,
    onClick,
  }: {
    children: React.ReactNode
    className?: string
    onClick?: () => void
  }) => (
    <div data-testid="quick-app-card-header" className={className} onClick={onClick}>
      {children}
    </div>
  ),
  CardFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h3 className={className}>{children}</h3>
  ),
  CardDescription: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
}))

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="share-dropdown">{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({
    children,
  }: {
    children: React.ReactNode
    align?: string
    className?: string
  }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

jest.mock("lucide-react", () => ({
  Sparkles: ({ className }: { className?: string }) => (
    <span data-testid="sparkles-icon" className={className}>
      sparkles
    </span>
  ),
  Play: ({ className }: { className?: string }) => <span className={className}>play</span>,
  Copy: ({ className }: { className?: string }) => <span className={className}>copy</span>,
  Download: ({ className }: { className?: string }) => <span className={className}>download</span>,
  Trash2: ({ className }: { className?: string }) => <span className={className}>trash</span>,
  Share2: ({ className }: { className?: string }) => <span className={className}>share</span>,
  Link: ({ className }: { className?: string }) => <span className={className}>link</span>,
  FileJson: ({ className }: { className?: string }) => <span className={className}>json</span>,
  Check: ({ className }: { className?: string }) => (
    <span data-testid="copied-check-icon" className={className}>
      check
    </span>
  ),
  Send: ({ className }: { className?: string }) => <span className={className}>twitter</span>,
  Users: ({ className }: { className?: string }) => <span className={className}>facebook</span>,
  Mail: ({ className }: { className?: string }) => <span className={className}>mail</span>,
  MessageCircle: ({ className }: { className?: string }) => (
    <span className={className}>telegram</span>
  ),
}))

const ResolvedTemplateIcon = ({ className }: { className?: string }) => (
  <span data-testid="resolved-template-icon" className={className}>
    icon
  </span>
)

const baseApp: A2UIAppInstance = {
  id: "app-1",
  templateId: "template-1",
  name: "My Quick App",
  createdAt: Date.now() - 24 * 60 * 60 * 1000,
  lastModified: Date.now() - 60 * 60 * 1000,
  version: "1.2.0",
}

const baseTemplate: A2UIAppTemplate = {
  id: "template-1",
  name: "Finance Helper",
  description: "Finance related helper app",
  icon: "Calculator",
  category: "utility",
  components: [],
  dataModel: {},
  tags: ["finance", "tools"],
}

const renderCard = (overrides?: Partial<React.ComponentProps<typeof QuickAppCard>>) => {
  const props: React.ComponentProps<typeof QuickAppCard> = {
    app: baseApp,
    template: baseTemplate,
    isActive: false,
    viewMode: "grid",
    onSelect: jest.fn(),
    onDuplicate: jest.fn(),
    onDownload: jest.fn(),
    onDelete: jest.fn(),
    onCopyToClipboard: jest.fn().mockResolvedValue(true),
    onNativeShare: jest.fn().mockResolvedValue(undefined),
    onSocialShare: jest.fn(),
    ...overrides,
  }

  const result = render(<QuickAppCard {...props} />)
  return { ...result, props }
}

describe("QuickAppCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveIcon.mockReturnValue(ResolvedTemplateIcon)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("renders app and template details", () => {
    renderCard()

    expect(screen.getByText("My Quick App")).toBeInTheDocument()
    expect(screen.getByText(/Finance Helper/)).toBeInTheDocument()
    expect(screen.getByTestId("resolved-template-icon")).toBeInTheDocument()
  })

  it("falls back to default app label and icon when template is missing", () => {
    mockResolveIcon.mockReturnValueOnce(null)
    renderCard({ template: undefined })

    expect(screen.getByText(/Custom App/)).toBeInTheDocument()
    expect(screen.getByTestId("sparkles-icon")).toBeInTheDocument()
  })

  it("calls onSelect when header is clicked", () => {
    const onSelect = jest.fn()
    renderCard({ onSelect })

    fireEvent.click(screen.getByTestId("quick-app-card-header"))
    expect(onSelect).toHaveBeenCalledWith("app-1")
  })

  it("calls duplicate, download, and delete handlers", () => {
    const onDuplicate = jest.fn()
    const onDownload = jest.fn()
    const onDelete = jest.fn()
    renderCard({ onDuplicate, onDownload, onDelete })

    fireEvent.click(screen.getByTitle("Duplicate"))
    fireEvent.click(screen.getByTitle("Export"))
    fireEvent.click(screen.getByTitle("Delete"))

    expect(onDuplicate).toHaveBeenCalledWith("app-1")
    expect(onDownload).toHaveBeenCalledWith("app-1")
    expect(onDelete).toHaveBeenCalledWith("app-1")
  })

  it("copies share link and resets copied state after timeout", async () => {
    jest.useFakeTimers()
    const onCopyToClipboard = jest.fn().mockResolvedValue(true)
    renderCard({ onCopyToClipboard })

    fireEvent.click(screen.getByRole("button", { name: /Copy Link/i }))

    await waitFor(() => {
      expect(onCopyToClipboard).toHaveBeenCalledWith("app-1", "url")
    })
    await waitFor(() => {
      expect(screen.getByTestId("copied-check-icon")).toBeInTheDocument()
    })

    act(() => {
      jest.advanceTimersByTime(2000)
    })

    await waitFor(() => {
      expect(screen.queryByTestId("copied-check-icon")).not.toBeInTheDocument()
    })
  })

  it("calls native and social share handlers", () => {
    const onNativeShare = jest.fn().mockResolvedValue(undefined)
    const onSocialShare = jest.fn()
    renderCard({ onNativeShare, onSocialShare })

    fireEvent.click(screen.getByRole("button", { name: /System Share/i }))
    fireEvent.click(screen.getByRole("button", { name: /Share to Twitter/i }))
    fireEvent.click(screen.getByRole("button", { name: /Share to Facebook/i }))
    fireEvent.click(screen.getByRole("button", { name: /Share to Telegram/i }))
    fireEvent.click(screen.getByRole("button", { name: /Share by Email/i }))

    expect(onNativeShare).toHaveBeenCalledWith("app-1")
    expect(onSocialShare).toHaveBeenCalledWith("app-1", "twitter")
    expect(onSocialShare).toHaveBeenCalledWith("app-1", "facebook")
    expect(onSocialShare).toHaveBeenCalledWith("app-1", "telegram")
    expect(onSocialShare).toHaveBeenCalledWith("app-1", "email")
  })

  it("applies active styles in list mode when selected", () => {
    renderCard({ isActive: true, viewMode: "list" })

    const card = screen.getByTestId("quick-app-card")
    expect(card.className).toContain("ring-2")
    expect(card.className).toContain("flex")
  })
})
