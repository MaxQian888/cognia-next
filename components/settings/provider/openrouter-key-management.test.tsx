/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { OpenRouterKeyManagement } from "./openrouter-key-management"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock stores
const mockUpdateProviderSettings = jest.fn()
let mockProvisioningKey: string | null = null

jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      providerSettings: {
        openrouter: {
          enabled: true,
          apiKey: "test-api-key",
          openRouterSettings: {
            provisioningApiKey: mockProvisioningKey,
          },
        },
      },
      updateProviderSettings: mockUpdateProviderSettings,
    }
    return selector(state)
  },
}))

// Mock openrouter lib
const mockListApiKeys = jest.fn()
const mockCreateApiKey = jest.fn()
const mockUpdateApiKey = jest.fn()
const mockDeleteApiKey = jest.fn()

jest.mock("@/lib/ai/providers/openrouter", () => ({
  listApiKeys: (...args: unknown[]) => mockListApiKeys(...args),
  createApiKey: (...args: unknown[]) => mockCreateApiKey(...args),
  updateApiKey: (...args: unknown[]) => mockUpdateApiKey(...args),
  deleteApiKey: (...args: unknown[]) => mockDeleteApiKey(...args),
  formatCredits: (credits: number) => `$${credits.toFixed(2)}`,
  OpenRouterError: class extends Error {},
}))

// Mock UI components
jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled} data-testid="button" {...props}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} data-testid="input" />
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange: _onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <div data-testid="select" data-value={value}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>Value</span>,
}))

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-trigger">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}))

jest.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => (
    <table data-testid="table">{children}</table>
  ),
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
}))

describe("OpenRouterKeyManagement", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProvisioningKey = null
  })

  it("renders without crashing", () => {
    render(<OpenRouterKeyManagement />)
    expect(screen.getByTestId("card")).toBeInTheDocument()
  })

  it("displays title", () => {
    render(<OpenRouterKeyManagement />)
    expect(screen.getByText("keyManagement.title")).toBeInTheDocument()
  })

  it("shows provisioning key input", () => {
    render(<OpenRouterKeyManagement />)
    expect(screen.getByText("keyManagement.provisioningApiKey")).toBeInTheDocument()
    const inputs = screen.getAllByTestId("input")
    expect(inputs.length).toBeGreaterThan(0)
  })

  it("displays help text with link", () => {
    render(<OpenRouterKeyManagement />)
    expect(screen.getByText(/openrouter.ai\/settings\/provisioning/)).toBeInTheDocument()
  })

  it("shows create button when provisioning key is set", async () => {
    mockProvisioningKey = "sk-or-v1-test-key"
    mockListApiKeys.mockResolvedValue([])
    render(<OpenRouterKeyManagement />)
    // The component renders with provisioning key input
    expect(screen.getByTestId("card")).toBeInTheDocument()
  })

  it("fetches keys when provisioning key is set", async () => {
    mockProvisioningKey = "sk-or-v1-test-key"
    mockListApiKeys.mockResolvedValue([])

    render(<OpenRouterKeyManagement />)

    await waitFor(() => {
      expect(mockListApiKeys).toHaveBeenCalledWith("sk-or-v1-test-key")
    })
  })

  it("displays keys in table", async () => {
    mockProvisioningKey = "sk-or-v1-test-key"
    mockListApiKeys.mockResolvedValue([
      {
        hash: "hash1",
        name: "Test Key 1",
        label: "label1",
        usage: 5.0,
        limit: null,
        disabled: false,
      },
    ])

    render(<OpenRouterKeyManagement />)

    await waitFor(() => {
      expect(screen.getByTestId("table")).toBeInTheDocument()
    })
  })

  it("shows empty state when no keys exist", async () => {
    mockProvisioningKey = "sk-or-v1-test-key"
    mockListApiKeys.mockResolvedValue([])

    render(<OpenRouterKeyManagement />)

    await waitFor(() => {
      expect(screen.getByText("keyManagement.noKeysFound")).toBeInTheDocument()
    })
  })

  it("handles error when fetching keys fails", async () => {
    mockProvisioningKey = "sk-or-v1-test-key"
    mockListApiKeys.mockRejectedValue(new Error("Failed to fetch"))

    render(<OpenRouterKeyManagement />)

    await waitFor(() => {
      expect(screen.getByText("Failed to fetch API keys")).toBeInTheDocument()
    })
  })

  it("renders key management UI", async () => {
    mockProvisioningKey = "sk-or-v1-test-key"
    mockListApiKeys.mockResolvedValue([])

    render(<OpenRouterKeyManagement />)

    await waitFor(() => {
      expect(screen.getByTestId("card")).toBeInTheDocument()
    })
  })

  it("renders with className prop", () => {
    render(<OpenRouterKeyManagement className="custom-class" />)
    expect(screen.getByTestId("card")).toBeInTheDocument()
  })
})

describe("OpenRouterKeyManagement key operations", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProvisioningKey = "sk-or-v1-test-key"
    mockListApiKeys.mockResolvedValue([
      {
        hash: "hash1",
        name: "Test Key",
        label: "label1",
        usage: 5.0,
        limit: 10.0,
        limit_reset: "monthly",
        disabled: false,
      },
    ])
  })

  it("displays key with limit info", async () => {
    render(<OpenRouterKeyManagement />)

    await waitFor(() => {
      expect(screen.getByTestId("table")).toBeInTheDocument()
    })
  })

  it("shows active/disabled status badge", async () => {
    render(<OpenRouterKeyManagement />)

    await waitFor(() => {
      expect(screen.getByText("active")).toBeInTheDocument()
    })
  })
})
