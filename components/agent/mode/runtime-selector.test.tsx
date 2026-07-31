/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { AgentRuntimeSelector } from "./runtime-selector"

// Passthrough i18n — assertions use raw translation keys.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Flatten Radix dropdown primitives so the content is always visible and
// RadioItems are directly clickable in jsdom without pointer-event plumbing.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    children,
    disabled,
    className,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode
    disabled?: boolean
    className?: string
    "aria-label"?: string
  }) => (
    <button disabled={disabled} className={className} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value: string
    onValueChange: (v: string) => void
  }) => (
    <div data-value={value} data-testid="radio-group">
      {/* Expose a test hook button for each known runtime value */}
      <button
        data-testid="set-runtime-claude-sdk"
        style={{ display: "none" }}
        onClick={() => onValueChange("claude-sdk")}
      />
      <button
        data-testid="set-runtime-external"
        style={{ display: "none" }}
        onClick={() => onValueChange("external")}
      />
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    value,
    disabled,
  }: {
    children: React.ReactNode
    value: string
    disabled?: boolean
  }) => (
    <div
      data-testid={`radio-item-${value}`}
      role="menuitemradio"
      aria-checked={false}
      aria-disabled={disabled ?? false}
      data-value={value}
    >
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}))

const mockSetRuntime = jest.fn()
const runtimeState = {
  runtime: "claude-sdk" as "claude-sdk" | "external",
  setRuntime: mockSetRuntime,
  externalAgentId: null as string | null,
}

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: (selector: (s: typeof runtimeState) => unknown) => selector(runtimeState),
}))

const externalAgentState = {
  enabled: true,
  agents: {} as Record<string, { name: string; enabled: boolean }>,
}

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (s: typeof externalAgentState) => unknown) =>
    selector(externalAgentState),
}))

beforeEach(() => {
  runtimeState.runtime = "claude-sdk"
  runtimeState.externalAgentId = null
  externalAgentState.enabled = true
  externalAgentState.agents = {}
  mockSetRuntime.mockClear()
})

describe("AgentRuntimeSelector — render", () => {
  it("renders without crashing", () => {
    render(<AgentRuntimeSelector />)
  })

  it("shows the claudeSdk label when runtime is claude-sdk", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getAllByText("claudeSdk").length).toBeGreaterThan(0)
  })

  it("shows the externalUnconfigured label when runtime is external but no agent id", () => {
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = null
    render(<AgentRuntimeSelector />)
    expect(screen.getAllByText("externalUnconfigured").length).toBeGreaterThan(0)
  })

  it("shows the external agent name when runtime is external and agent is known", () => {
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "agent-1"
    externalAgentState.agents = { "agent-1": { name: "Codex", enabled: true } }
    render(<AgentRuntimeSelector />)
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
  })

  it("renders both radio items for claude-sdk and external", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("radio-item-claude-sdk")).toBeInTheDocument()
    expect(screen.getByTestId("radio-item-external")).toBeInTheDocument()
  })

  it("renders aria label from translation key", () => {
    render(<AgentRuntimeSelector />)
    const trigger = document.querySelector("button[aria-label]")
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute("aria-label")).toBe("ariaLabel")
  })
})

describe("AgentRuntimeSelector — disabled prop", () => {
  it("disables the trigger button when disabled=true", () => {
    render(<AgentRuntimeSelector disabled />)
    const trigger = document.querySelector("button[disabled]")
    expect(trigger).not.toBeNull()
  })

  it("does not disable the trigger button by default", () => {
    render(<AgentRuntimeSelector />)
    const trigger = document.querySelector("button[disabled]")
    expect(trigger).toBeNull()
  })
})

describe("AgentRuntimeSelector — className prop", () => {
  it("forwards className to the trigger", () => {
    render(<AgentRuntimeSelector className="my-custom-class" />)
    const trigger = document.querySelector("button.my-custom-class")
    expect(trigger).not.toBeNull()
  })
})

describe("AgentRuntimeSelector — runtime switching", () => {
  it("calls setRuntime with 'external' when onValueChange fires with 'external'", () => {
    externalAgentState.agents = { "agent-1": { name: "Codex", enabled: true } }
    render(<AgentRuntimeSelector />)
    const hookBtn = screen.getByTestId("set-runtime-external")
    fireEvent.click(hookBtn)
    expect(mockSetRuntime).toHaveBeenCalledWith("external")
  })

  it("does not select the external runtime when no enabled agent is configured", () => {
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("set-runtime-external"))
    expect(mockSetRuntime).not.toHaveBeenCalled()
  })

  it("falls back to the built-in runtime when an invalid external selection is restored", () => {
    runtimeState.runtime = "external"
    render(<AgentRuntimeSelector />)
    expect(mockSetRuntime).toHaveBeenCalledWith("claude-sdk")
  })

  it("calls setRuntime with 'claude-sdk' when onValueChange fires with 'claude-sdk'", () => {
    runtimeState.runtime = "external"
    render(<AgentRuntimeSelector />)
    const hookBtn = screen.getByTestId("set-runtime-claude-sdk")
    fireEvent.click(hookBtn)
    expect(mockSetRuntime).toHaveBeenCalledWith("claude-sdk")
  })
})

describe("AgentRuntimeSelector — labels in content", () => {
  it("shows claudeSdk description key in menu", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getByText("claudeSdkDesc")).toBeInTheDocument()
  })

  it("shows external description key in menu", () => {
    externalAgentState.agents = { "agent-1": { name: "Codex", enabled: true } }
    render(<AgentRuntimeSelector />)
    expect(screen.getByText("externalDesc")).toBeInTheDocument()
  })

  it("shows setup guidance and disables external selection when no agent is configured", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getByText("externalEmpty")).toBeInTheDocument()
    expect(screen.getByTestId("radio-item-external")).toHaveAttribute("aria-disabled", "true")
  })

  it("allows the runtime label to use available toolbar width before truncating", () => {
    render(<AgentRuntimeSelector />)
    const trigger = screen.getByRole("button", { name: "ariaLabel" })
    expect(trigger.className).not.toContain("max-w-[9rem]")
  })

  it("shows label translation key as menu heading", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getByText("label")).toBeInTheDocument()
  })
})
