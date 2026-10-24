import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import type { DeviceRow } from "@/lib/devices/types"
import type { OrgAgentPolicy, OrgCredentialEntry } from "@/lib/remote-host/org-models"

import { OrgModelsSection, type OrgModelsSectionDeps } from "./org-models-section"

const row = { ref: "host:org", kind: "remote-host", label: "Org box", hostId: "org" } as DeviceRow

const keys: OrgCredentialEntry[] = [
  { provider: "claude", fingerprint: "a1b2c3d4e5f6", setAt: 1_000, setBy: "usr_ada" },
  { provider: "codex", fingerprint: "0f0f0f0f0f0f", setAt: 2_000, setBy: "operator" },
]

const policy: OrgAgentPolicy = {
  allowedAgents: [{ runtimeId: "claude-agent-acp", providers: ["claude"], available: true }],
  bundledAgents: [
    { runtimeId: "claude-agent-acp", providers: ["claude"], available: true },
    { runtimeId: "codex-acp", providers: ["codex"], available: true },
    { runtimeId: "qwen-code", providers: ["qwen"], available: false },
  ],
  defaultAgent: "claude-agent-acp",
  updatedAt: 3_000,
  updatedBy: "usr_ada",
}

function deps(overrides: OrgModelsSectionDeps = {}): Required<OrgModelsSectionDeps> {
  return {
    listCredentials: jest.fn(async () => keys),
    getPolicy: jest.fn(async () => policy),
    setCredential: jest.fn(async (_host, write) => ({
      provider: write.provider,
      fingerprint: "ffffffffffff",
      setAt: 4_000,
      setBy: "usr_ada",
    })),
    deleteCredential: jest.fn(async () => undefined),
    setPolicy: jest.fn(async () => policy),
    ...overrides,
  } as Required<OrgModelsSectionDeps>
}

beforeEach(() => jest.clearAllMocks())

describe("OrgModelsSection", () => {
  it("lists keys by fingerprint and provenance, never by value", async () => {
    render(<OrgModelsSection row={row} deps={deps()} />)
    const claude = await screen.findByTestId("org-key-claude")
    expect(claude).toHaveTextContent("key a1b2c3d4e5f6")
    expect(claude).toHaveTextContent("by an admin")
    expect(screen.getByTestId("org-key-codex")).toHaveTextContent("from the host's command line")
  })

  it("marks agents no org key can serve and keeps the saved choice checked", async () => {
    render(<OrgModelsSection row={row} deps={deps()} />)
    const agents = await screen.findByTestId("org-models-agents")
    expect(within(agents).getByLabelText("Claude Code ACP adapter")).toBeInTheDocument()
    // The org has keys, so an agent none of them can serve has no brokered launch.
    expect(screen.getByTestId("org-agent-qwen-code-unsupported")).toHaveTextContent(
      "Not available here"
    )
    expect(screen.queryByTestId("org-agent-codex-acp-unsupported")).not.toBeInTheDocument()
    expect(screen.getByTestId("org-agent-claude-agent-acp")).toHaveAttribute(
      "data-state",
      "checked"
    )
    expect(screen.getByTestId("org-agent-codex-acp")).toHaveAttribute("data-state", "unchecked")
    // Nothing changed, so there is nothing to save.
    expect(screen.getByTestId("org-agents-save")).toBeDisabled()
  })

  it("marks every agent No key until the org has a key", async () => {
    const none = policy.bundledAgents.map((agent) => ({
      ...agent,
      providers: [],
      available: false,
    }))
    render(
      <OrgModelsSection
        row={row}
        deps={deps({
          listCredentials: jest.fn(async () => []),
          getPolicy: jest.fn(async () => ({ ...policy, allowedAgents: [], bundledAgents: none })),
        })}
      />
    )
    expect(await screen.findByTestId("org-models-no-keys")).toBeInTheDocument()
    expect(screen.getByTestId("org-agent-codex-acp-no-key")).toHaveTextContent("No key")
    expect(screen.queryByTestId("org-agent-codex-acp-unsupported")).not.toBeInTheDocument()
  })

  it("saves the allowlist in the Host's order and keeps the default when it stays allowed", async () => {
    const d = deps()
    render(<OrgModelsSection row={row} deps={d} />)
    await userEvent.click(await screen.findByTestId("org-agent-codex-acp"))
    await userEvent.click(screen.getByTestId("org-agents-save"))
    await waitFor(() =>
      expect(d.setPolicy).toHaveBeenCalledWith("org", {
        allowedAgents: ["claude-agent-acp", "codex-acp"],
        defaultAgent: "claude-agent-acp",
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith("Saved the agents for Org box")
  })

  it("moves the default to the first allowed agent when the default is unchecked", async () => {
    const d = deps()
    render(<OrgModelsSection row={row} deps={d} />)
    await userEvent.click(await screen.findByTestId("org-agent-codex-acp"))
    await userEvent.click(screen.getByTestId("org-agent-claude-agent-acp"))
    await userEvent.click(screen.getByTestId("org-agents-save"))
    await waitFor(() =>
      expect(d.setPolicy).toHaveBeenCalledWith("org", {
        allowedAgents: ["codex-acp"],
        defaultAgent: "codex-acp",
      })
    )
  })

  it("sends a new key, clears the field, and reads the list again", async () => {
    const d = deps()
    render(<OrgModelsSection row={row} deps={d} />)
    await screen.findByTestId("org-models-add")
    const user = userEvent.setup()
    await user.click(screen.getByTestId("org-key-provider"))
    // The picker offers the app's providers even before the org has any key.
    await user.click(await screen.findByRole("option", { name: "DeepSeek" }))
    const input = screen.getByTestId("org-key-value")
    fireEvent.change(input, { target: { value: "sk-org" } })
    await userEvent.click(screen.getByTestId("org-key-save"))
    await waitFor(() =>
      expect(d.setCredential).toHaveBeenCalledWith("org", {
        provider: "deepseek",
        apiKey: "sk-org",
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith("Saved the DeepSeek key on Org box")
    expect(input).toHaveValue("")
    await waitFor(() => expect(d.listCredentials).toHaveBeenCalledTimes(2))
  })

  it("removes a key only after confirming", async () => {
    const d = deps()
    render(<OrgModelsSection row={row} deps={d} />)
    await userEvent.click(await screen.findByTestId("org-key-remove-codex"))
    expect(d.deleteCredential).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId("org-key-remove-confirm"))
    await waitFor(() => expect(d.deleteCredential).toHaveBeenCalledWith("org", "codex"))
    expect(toastSuccess).toHaveBeenCalledWith("Removed the Codex (OpenAI) key from Org box")
  })

  it("tells a member why there is nothing to manage", async () => {
    const forbidden = Object.assign(new Error("forbidden"), { code: "host_surface_forbidden" })
    render(
      <OrgModelsSection
        row={row}
        deps={deps({ listCredentials: jest.fn(async () => Promise.reject(forbidden)) })}
      />
    )
    expect(await screen.findByTestId("org-models-not-admin")).toHaveTextContent(
      "Only an owner or admin"
    )
    expect(screen.queryByTestId("org-models-add")).not.toBeInTheDocument()
  })

  it("says a single-user Host has no organization models", async () => {
    const single = Object.assign(new Error("nope"), { code: "org_scope_unavailable" })
    render(
      <OrgModelsSection
        row={row}
        deps={deps({ getPolicy: jest.fn(async () => Promise.reject(single)) })}
      />
    )
    expect(await screen.findByTestId("org-models-not-org-host")).toHaveTextContent(
      "Org box doesn't serve an organization"
    )
  })

  it("shows any other failure as it came", async () => {
    render(
      <OrgModelsSection
        row={row}
        deps={deps({ listCredentials: jest.fn(async () => Promise.reject(new Error("timeout"))) })}
      />
    )
    expect(await screen.findByText("timeout")).toBeInTheDocument()
  })

  it("renders nothing for a host it cannot reach", () => {
    const { container } = render(
      <OrgModelsSection
        row={
          {
            ...row,
            hostId: undefined,
            ref: "companion:org",
            runtime: { isRoutingTarget: false },
          } as DeviceRow
        }
        deps={deps()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
