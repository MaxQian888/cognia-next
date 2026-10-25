import { act, fireEvent, render, screen } from "@testing-library/react"

import type { PersonAgentsManifest } from "@/lib/platform/host-feature-manifest"

import { PersonAgentChip } from "./person-agent-chip"

// Passthrough i18n: assertions read raw keys plus the interpolated values.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useFormatter: () => ({ number: (value: number) => String(value) }),
}))

// Flatten the picker, cmdk and tooltip so the panel is always rendered.
jest.mock("@/components/shared/responsive-picker", () => ({
  ResponsivePicker: ({
    trigger,
    children,
  }: {
    trigger: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {trigger}
      <div data-testid="person-agent-panel">{children}</div>
    </div>
  ),
}))
jest.mock("@/components/ui/command", () => ({
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children, heading }: { children: React.ReactNode; heading?: string }) => (
    <div>
      <div>{heading}</div>
      {children}
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    disabled,
    value: _value,
    ...rest
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
    value?: string
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      role="option"
      aria-selected={false}
      aria-disabled={disabled ?? false}
      {...rest}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
    >
      {children}
    </div>
  ),
}))
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="person-agent-tooltip">{children}</div>
  ),
}))

const agents: PersonAgentsManifest = {
  allowedAgents: [
    { runtimeId: "claude-agent-acp", available: true, providers: ["deepseek"] },
    { runtimeId: "codex-acp", available: false, providers: [] },
  ],
  defaultAgent: "claude-agent-acp",
  execution: "sandboxed",
  models: { deepseek: ["ark-deepseek-v4.1-flash"] },
  usage: { month: "2026-10", spentTokens: 300, reservedTokens: 100, monthlyTokens: 1000 },
}

const served = { providerOverride: "deepseek", model: "ark-deepseek-v4.1-flash" }

function renderChip(overrides: Partial<React.ComponentProps<typeof PersonAgentChip>> = {}) {
  const refresh = jest.fn(async () => undefined)
  const onStartConversation = jest.fn(async () => undefined)
  render(
    <PersonAgentChip
      agents={agents}
      refresh={refresh}
      session={served}
      onStartConversation={onStartConversation}
      {...overrides}
    />
  )
  return { refresh, onStartConversation }
}

describe("PersonAgentChip", () => {
  it("p6g names the conversation's agent, that it is fixed, and what is left of the month", () => {
    const { refresh } = renderChip()
    expect(screen.getByTestId("person-agent-trigger")).toHaveTextContent("Claude")
    expect(screen.getByTestId("person-agent-current")).toHaveTextContent("current.default")
    expect(screen.getByTestId("person-agent-current")).toHaveTextContent("current.locked")
    expect(screen.getByTestId("person-agent-allowance")).toHaveTextContent(
      'allowance.left {"left":"600","cap":"1000"}'
    )
    expect(screen.queryByTestId("person-agent-problem")).toBeNull()
    // Spend moves every turn: the chip re-reads when it appears.
    expect(refresh).toHaveBeenCalled()
  })

  it("p6g starts a new conversation with the chosen agent and a model the org serves", async () => {
    const { onStartConversation } = renderChip({
      session: { providerOverride: "openai", model: "gpt" },
    })
    // This conversation's model is not served: say why before a turn fails.
    expect(screen.getByTestId("person-agent-problem")).toHaveTextContent("problem.model-not-served")
    expect(screen.getByTestId("person-agent-trigger")).toHaveAttribute("data-warn", "true")
    await act(async () => {
      fireEvent.click(screen.getByTestId("person-agent-start-claude-agent-acp"))
    })
    expect(onStartConversation).toHaveBeenCalledWith({
      agentRuntimeId: "claude-agent-acp",
      providerOverride: "deepseek",
      model: "ark-deepseek-v4.1-flash",
    })
  })

  it("p6g labels an agent without a key and never starts it", async () => {
    const { onStartConversation } = renderChip()
    const codex = screen.getByTestId("person-agent-start-codex-acp")
    expect(codex).toHaveAttribute("aria-disabled", "true")
    expect(codex).toHaveTextContent("badge.noKey")
    expect(screen.getByTestId("person-agent-start-claude-agent-acp")).toHaveTextContent(
      "badge.default"
    )
    await act(async () => {
      fireEvent.click(codex)
    })
    expect(onStartConversation).not.toHaveBeenCalled()
  })

  it("p6g warns before the cap refuses a turn and offers no new agent run", () => {
    renderChip({
      agents: {
        ...agents,
        usage: { month: "2026-10", spentTokens: 1000, reservedTokens: 0, monthlyTokens: 1000 },
      },
    })
    expect(screen.getByTestId("person-agent-allowance")).toHaveTextContent("allowance.usedUp")
    expect(screen.getByTestId("person-agent-trigger")).toHaveAttribute("data-warn", "true")
    expect(screen.getByTestId("person-agent-start-claude-agent-acp")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("p6g shows plain chat, no cap, and a Host that runs no member agents", () => {
    renderChip({
      agents: {
        ...agents,
        defaultAgent: null,
        execution: "none",
        usage: { month: "2026-10", spentTokens: 7, reservedTokens: 0, monthlyTokens: null },
      },
    })
    expect(screen.getByTestId("person-agent-trigger")).toHaveTextContent("chat")
    expect(screen.getByTestId("person-agent-current")).toHaveTextContent("current.chat")
    expect(screen.getByTestId("person-agent-allowance")).toHaveTextContent(
      'allowance.unlimited {"spent":"7"}'
    )
    expect(screen.getByTestId("person-agent-no-execution")).toBeInTheDocument()
    expect(screen.queryByTestId("person-agent-start-claude-agent-acp")).toBeNull()
  })

  it("p6g leaves the month out when the Host keeps no ledger, and goes icon-only when dense", () => {
    renderChip({ agents: { ...agents, usage: null }, dense: true })
    expect(screen.queryByTestId("person-agent-allowance")).toBeNull()
    expect(screen.getByTestId("person-agent-trigger")).not.toHaveTextContent("Claude")
    expect(screen.getByTestId("person-agent-trigger")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("ariaLabel")
    )
  })
})
