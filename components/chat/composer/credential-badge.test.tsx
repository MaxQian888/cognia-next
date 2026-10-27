import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerCredentialBadge } from "./credential-badge"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockCredentialStatus = jest.fn((..._args: unknown[]) => ({
  keyOk: true as boolean | null,
  plan: null,
}))
jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: (...args: unknown[]) => mockCredentialStatus(...args),
}))

const mockRoute = {
  runtime: { kind: "builtin" } as import("@/lib/ai/agent/runtime-catalog/types").AgentRuntimeRef,
  settings: {} as import("@cognia/agent-config-types").AppSettings,
  character: undefined as import("@cognia/agent-config-types").Character | null | undefined,
  agents: {} as Record<string, unknown>,
  gateway: { status: "idle", providers: [] } as {
    status: string
    providers: Array<{ providerId: string; models: Array<{ id: string }>; accountIds?: string[] }>
  },
}
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => mockRoute.runtime,
}))
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (value: unknown) => unknown) =>
    selector({ agents: mockRoute.agents }),
}))
jest.mock("@/lib/data-hooks/context", () => ({ useCharacter: () => mockRoute.character }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (value: unknown) => unknown) =>
    selector({ settings: mockRoute.settings }),
}))
jest.mock("@/hooks/agent/use-cognia-gateway-models", () => ({
  useCogniaGatewayModels: () => mockRoute.gateway,
}))
jest.mock("@/hooks/chat/use-person-agents", () => ({ usePersonAgents: () => ({ agents: null }) }))
beforeEach(() => {
  mockRoute.runtime = { kind: "builtin" }
  mockRoute.character = undefined
  mockRoute.agents = {}
  mockRoute.settings = {} as never
  mockRoute.gateway = { status: "idle", providers: [] }
})

function renderBadge(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe("ComposerCredentialBadge", () => {
  it("renders nothing while a key or subscription bearer is configured", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    renderBadge(<ComposerCredentialBadge />)
    expect(screen.queryByTestId("composer-credential-badge")).toBeNull()
  })

  it("stays quiet while the status is still resolving", () => {
    // `null` = not yet known; only a definite `false` warns.
    mockCredentialStatus.mockReturnValue({ keyOk: null, plan: null })
    renderBadge(<ComposerCredentialBadge />)
    expect(screen.queryByTestId("composer-credential-badge")).toBeNull()
  })

  it("warns, and opens provider settings on click, when no credential exists", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    const onOpenSettings = jest.fn()
    renderBadge(<ComposerCredentialBadge onOpenSettings={onOpenSettings} />)
    const badge = screen.getByRole("button", { name: "noApiKey" })
    expect(badge).toHaveAttribute("data-testid", "composer-credential-badge")
    fireEvent.click(badge)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  // It used to be a `span role="button"` that Tab walked straight past.
  it("is a real button the keyboard can reach", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge onOpenSettings={jest.fn()} />)
    const badge = screen.getByTestId("composer-credential-badge")
    expect(badge.tagName).toBe("BUTTON")
    badge.focus()
    expect(badge).toHaveFocus()
  })

  it("wears the toolbar row's chip geometry, not a pill badge's", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge onOpenSettings={jest.fn()} />)
    const badge = screen.getByTestId("composer-credential-badge")
    expect(badge.className).toContain("h-7")
    expect(badge.className).toContain("rounded-md")
    expect(badge.className).toContain("text-destructive")
    expect(badge.className).not.toMatch(/(^|\s)text-muted-foreground(\s|$)/)
  })

  it("folds to the key glyph and keeps saying what is wrong", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge onOpenSettings={jest.fn()} glyph />)
    const badge = screen.getByRole("button", { name: "noApiKey" })
    expect(badge).toHaveAttribute("data-glyph", "true")
    expect(badge).not.toHaveTextContent("noApiKey")
    expect(badge.className).toContain("w-7")
  })

  it("is a status, not a dead button, when there is nowhere to send the user", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: false, plan: null })
    renderBadge(<ComposerCredentialBadge />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByRole("status", { name: "noApiKey" })).toBeInTheDocument()
  })
})

describe("credential route binding", () => {
  it("does not borrow a local credential marker for a native Host configuration", () => {
    mockRoute.runtime = { kind: "host", configId: "remote", revision: "r1", lifecycleGeneration: 1 }
    mockRoute.agents = { remote: { metadata: { __cognia_credential_required__: ["apiKey"] } } }
    mockCredentialStatus.mockReturnValue({ keyOk: null, plan: null })
    renderBadge(<ComposerCredentialBadge />)
    expect(screen.queryByRole("status")).toBeNull()
  })
  it("includes the Character provider and account in the selected builtin route", () => {
    mockRoute.character = { providerId: "openai", accountIdOverride: "character-account" } as never
    renderBadge(
      <ComposerCredentialBadge
        session={{ id: "character-chat", characterId: "character" } as never}
      />
    )
    expect(mockCredentialStatus).toHaveBeenLastCalledWith({
      providerId: "openai",
      accountId: "character-account",
      gateway: false,
    })
  })

  const session = {
    id: "selected",
    createdAt: 1,
    updatedAt: 1,
    kind: "direct",
    title: "selected",
  } as import("@cognia/agent-config-types").ChatSession
  it("passes the selected built-in provider to the credential probe", () => {
    renderBadge(<ComposerCredentialBadge session={{ ...session, providerOverride: "deepseek" }} />)
    expect(mockCredentialStatus).toHaveBeenLastCalledWith({
      providerId: "deepseek",
      accountId: null,
      gateway: false,
    })
  })
  it("probes a local Agent's gateway binding without reading a leftover builtin model", () => {
    mockRoute.runtime = { kind: "external", agentId: "dsh" }
    mockRoute.gateway = {
      status: "ready",
      providers: [{ providerId: "deepseek", models: [{ id: "flash" }] }],
    }
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    renderBadge(
      <ComposerCredentialBadge
        session={{
          ...session,
          providerOverride: "anthropic",
          externalAgentModels: {
            dsh: {
              kind: "cognia",
              binding: { providerId: "deepseek", modelId: "flash", accountId: null },
            },
          },
        }}
      />
    )
    expect(mockCredentialStatus).toHaveBeenLastCalledWith({
      providerId: "deepseek",
      accountId: null,
      gateway: true,
    })
    expect(screen.queryByRole("status")).toBeNull()
  })
  it("reports a missing native credential from the Agent's import marker", () => {
    mockRoute.runtime = { kind: "external", agentId: "dsh" }
    mockRoute.agents = {
      dsh: { id: "dsh", metadata: { __cognia_credential_required__: ["apiKey"] } },
    }
    renderBadge(<ComposerCredentialBadge session={session} onOpenSettings={jest.fn()} />)
    expect(screen.getByRole("status", { name: "externalCredentialsRequired" })).toBeInTheDocument()
    expect(mockCredentialStatus).toHaveBeenLastCalledWith({
      providerId: null,
      accountId: undefined,
      gateway: false,
    })
  })
  it("reports an unavailable gateway separately from missing credentials", () => {
    mockRoute.runtime = { kind: "external", agentId: "dsh" }
    mockRoute.gateway.status = "unavailable"
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    renderBadge(
      <ComposerCredentialBadge
        session={{
          ...session,
          externalAgentModels: {
            dsh: { kind: "cognia", binding: { providerId: "deepseek", modelId: "flash" } },
          },
        }}
      />
    )
    expect(screen.getByRole("status", { name: "gatewayUnavailable" })).toBeInTheDocument()
  })
  it("uses the Host catalog for a Host-owned gateway rather than local keys", () => {
    mockRoute.agents = { remote: { metadata: { __cognia_credential_required__: ["apiKey"] } } }
    mockRoute.runtime = { kind: "host", configId: "remote", revision: "r1", lifecycleGeneration: 1 }
    mockRoute.gateway = {
      status: "ready",
      providers: [
        { providerId: "deepseek", models: [{ id: "flash" }], accountIds: ["host-account"] },
      ],
    }
    mockCredentialStatus.mockReturnValue({ keyOk: null, plan: null })
    renderBadge(
      <ComposerCredentialBadge
        session={{
          ...session,
          externalAgentModels: {
            remote: {
              kind: "cognia",
              binding: { providerId: "deepseek", modelId: "flash", accountId: "host-account" },
            },
          },
        }}
      />
    )
    expect(mockCredentialStatus).toHaveBeenLastCalledWith({
      providerId: null,
      accountId: "host-account",
      gateway: true,
    })
    expect(screen.queryByRole("status")).toBeNull()
  })
})
