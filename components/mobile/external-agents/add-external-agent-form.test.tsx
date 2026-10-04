/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { AddExternalAgentForm } from "./add-external-agent-form"

const mockReplace = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  usePathname: () => "/me/external-agents/new/configure",
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const hostState: { current: HostExternalAgentConfigsState } = {
  current: {} as HostExternalAgentConfigsState,
}

jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => hostState.current,
}))

jest.mock("@/hooks/agent/use-installed-agent-runtimes", () => ({
  useInstalledAgentRuntimes: () => ({
    loading: false,
    unavailable: null,
    runtimes: [],
    forPreset: () => undefined,
    refresh: jest.fn(),
  }),
}))

jest.mock("@/hooks/agent/use-external-agent-process-plane", () => ({
  useExternalAgentProcessPlane: () => ({ ok: true }),
}))

// The model picker reads the settings and account stores; the form only
// renders it, so a stub keeps this suite about the form.
jest.mock("@/components/agent/external-agent/cognia-model-picker", () => ({
  CogniaModelPicker: () => null,
}))

const toastSuccess = toast.success as jest.Mock
const toastError = toast.error as jest.Mock

// Radix Select and the "open advanced settings" scroll need APIs jsdom lacks.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.setPointerCapture = jest.fn()
  Element.prototype.releasePointerCapture = jest.fn()
})

type CreateResult = Awaited<ReturnType<HostExternalAgentConfigsState["create"]>>

function setHost(over: Partial<HostExternalAgentConfigsState> = {}) {
  hostState.current = {
    configs: [],
    loading: false,
    unavailable: null,
    error: null,
    busy: false,
    refresh: jest.fn(async () => {}),
    reconcile: jest.fn(async () => {}),
    setEnabled: jest.fn(async () => {}),
    update: jest.fn(async () => true),
    remove: jest.fn(async () => true),
    copyLocal: jest.fn(async () => {}),
    create: jest.fn(
      async (): Promise<CreateResult> => ({
        ok: true,
        record: { configId: "eac_new" } as ExternalAgentConfigRecord,
      })
    ),
    ...over,
  }
}

function renderForm(presetId: string) {
  return render(
    <TooltipProvider>
      <AddExternalAgentForm presetId={presetId} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  setHost()
})

describe("AddExternalAgentForm", () => {
  it("explains an unknown preset instead of rendering a form", () => {
    renderForm("no-such-preset")
    expect(screen.getByTestId("add-agent-unknown-preset")).toHaveTextContent(
      "That agent is no longer available. Pick another one."
    )
    expect(screen.getByRole("link", { name: "Add external agent" })).toHaveAttribute(
      "href",
      "/me/external-agents/new"
    )
    expect(screen.queryByTestId("add-external-agent-form")).toBeNull()
  })

  it("says why when the Host cannot take an agent", () => {
    setHost({ unavailable: "unsupported" })
    renderForm("claude-code")
    expect(screen.getByTestId("add-agent-host-unavailable")).toHaveTextContent(
      /does not support host-owned external agents/
    )
    expect(screen.queryByTestId("add-external-agent-form")).toBeNull()
  })

  it("seeds a preset's name and keeps the advanced section closed", () => {
    renderForm("claude-code")
    expect(screen.getByTestId("add-agent-name")).toHaveValue("Claude Code")
    expect(screen.getByTestId("add-agent-advanced")).toHaveAttribute("data-state", "closed")
  })

  it("creates the agent on the Host, enabled, with the chosen permission mode", async () => {
    const user = userEvent.setup()
    renderForm("claude-code")

    await user.click(screen.getByTestId("add-agent-permission"))
    await user.click(await screen.findByRole("option", { name: "Plan" }))
    await user.click(screen.getByTestId("add-agent-submit"))

    const create = hostState.current.create as jest.Mock
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Claude Code",
        protocol: "acp",
        transport: "stdio",
        process: expect.objectContaining({ command: "claude-agent-acp" }),
        metadata: expect.objectContaining({ preset: "claude-code" }),
        defaultPermissionMode: "plan",
        enabled: true,
      })
    )
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/me/external-agents"))
    expect(toastSuccess).toHaveBeenCalledWith("Claude Code was added to your Host.")
    expect(screen.queryByTestId("add-agent-problem")).toBeNull()
  })

  it("submits the preset's default permission mode when none is picked", async () => {
    renderForm("claude-code")
    fireEvent.submit(screen.getByTestId("add-external-agent-form"))
    const create = hostState.current.create as jest.Mock
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0][0]).toMatchObject({ defaultPermissionMode: "default" })
  })

  it("opens advanced settings for a custom agent and asks for a name", async () => {
    renderForm("custom")
    expect(screen.getByTestId("add-agent-advanced")).toHaveAttribute("data-state", "open")
    expect(screen.getByTestId("add-agent-name")).toHaveValue("")

    fireEvent.submit(screen.getByTestId("add-external-agent-form"))

    expect(await screen.findByTestId("add-agent-problem")).toHaveTextContent(
      "Agent name is required"
    )
    expect(hostState.current.create).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("opens the advanced section itself when the fix lives there", async () => {
    const user = userEvent.setup()
    renderForm("custom")
    // Close it first, so the reopen is the submit's doing.
    await user.click(screen.getByTestId("add-agent-advanced-trigger"))
    expect(screen.getByTestId("add-agent-advanced")).toHaveAttribute("data-state", "closed")

    fireEvent.change(screen.getByTestId("add-agent-name"), { target: { value: "Mine" } })
    fireEvent.submit(screen.getByTestId("add-external-agent-form"))

    expect(await screen.findByTestId("add-agent-problem")).toHaveTextContent(
      "Command is required for stdio transport"
    )
    expect(screen.getByTestId("add-agent-advanced")).toHaveAttribute("data-state", "open")
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
    expect(hostState.current.create).not.toHaveBeenCalled()
  })

  it("shows a refused create where the user is looking and stays on the form", async () => {
    setHost({
      create: jest.fn(async (): Promise<CreateResult> => ({ ok: false, error: "boom" })),
    })
    renderForm("claude-code")
    fireEvent.submit(screen.getByTestId("add-external-agent-form"))

    expect(await screen.findByTestId("add-agent-problem")).toHaveTextContent(
      "Could not add the agent: boom"
    )
    expect(toastError).toHaveBeenCalledWith("Could not add the agent: boom")
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.getByTestId("add-agent-submit")).not.toBeDisabled()
  })

  it("disables submit while the Host list is still loading", () => {
    setHost({ loading: true })
    renderForm("claude-code")
    expect(screen.getByTestId("add-agent-submit")).toBeDisabled()
  })
})
