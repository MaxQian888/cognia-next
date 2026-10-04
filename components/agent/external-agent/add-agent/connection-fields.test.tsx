/**
 * @jest-environment jsdom
 */
import { useEffect } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"
import { useAddAgentForm, type AddAgentFormState } from "@/hooks/agent/use-add-agent-form"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"

import { ConnectionFields } from "./connection-fields"

const settings = en.externalAgent.settings as unknown as Record<string, string>
const manager = en.externalAgent.manager as unknown as Record<string, string>

let latestForm: AddAgentFormState | null = null

function Harness({
  presetId = "",
  planeWarning = null,
}: {
  presetId?: string
  planeWarning?: string | null
}) {
  const form = useAddAgentForm(presetId)
  useEffect(() => {
    latestForm = form
  })
  return (
    <>
      <ConnectionFields form={form} planeWarning={planeWarning} />
      <output data-testid="readout">
        {JSON.stringify({
          protocol: form.data.protocol,
          transport: form.data.transport,
          autoSpawnServer: form.data.autoSpawnServer,
          command: form.data.command,
          endpoint: form.data.endpoint,
        })}
      </output>
    </>
  )
}

function readout(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId("readout").textContent ?? "{}") as Record<string, unknown>
}

function form(): AddAgentFormState {
  if (!latestForm) throw new Error("harness not rendered")
  return latestForm
}

beforeEach(() => {
  latestForm = null
})

describe("ConnectionFields", () => {
  it("shows command, arguments and the bare/debug toggles for a stdio preset", () => {
    render(<Harness presetId="claude-code" />)

    expect(readout()).toMatchObject({ protocol: "acp", transport: "stdio" })
    expect(screen.getByLabelText(settings.command!)).toHaveValue(
      getPresetConfig("claude-code")!.process!.command
    )
    expect(screen.getByLabelText(settings.arguments!)).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: settings.passBareFlag })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: settings.passDebugFlag })).toBeInTheDocument()
    expect(screen.queryByLabelText(settings.endpoint!)).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: manager.autoSpawnServer })).not.toBeInTheDocument()
  })

  it("updates form data when a toggle or input changes", async () => {
    const user = userEvent.setup()
    render(<Harness presetId="claude-code" />)

    await user.click(screen.getByRole("switch", { name: settings.passBareFlag }))
    expect(form().data.bare).toBe(true)

    const command = screen.getByLabelText(settings.command!)
    await user.clear(command)
    await user.type(command, "my-agent")
    expect(readout()).toMatchObject({ command: "my-agent" })
  })

  it("switches the transport to sse when OpenCode V2 is picked from the protocol select", async () => {
    const user = userEvent.setup()
    render(<Harness presetId="claude-code" />)

    await user.click(screen.getByRole("combobox", { name: settings.protocol }))
    await user.click(await screen.findByRole("option", { name: settings.opencodeV2Protocol }))

    expect(readout()).toMatchObject({ protocol: "opencode-v2", transport: "sse" })
    expect(screen.queryByRole("switch", { name: settings.passBareFlag })).not.toBeInTheDocument()
    // V2 discovers its local service; asking for an endpoint (required, at
    // that) would block a form the validator accepts.
    expect(screen.queryByLabelText(settings.endpoint)).not.toBeInTheDocument()
  })

  it("switches the transport to http when A2A is picked from the protocol select", async () => {
    const user = userEvent.setup()
    render(<Harness presetId="claude-code" />)

    await user.click(screen.getByRole("combobox", { name: settings.protocol }))
    await user.click(await screen.findByRole("option", { name: "A2A (Agent-to-Agent)" }))

    expect(readout()).toMatchObject({ protocol: "a2a", transport: "http" })
    expect(screen.getByLabelText(settings.endpoint!)).toBeInTheDocument()
  })

  it("does not offer the retired OpenCode V1 protocol as a selectable option", async () => {
    const user = userEvent.setup()
    render(<Harness presetId="claude-code" />)

    await user.click(screen.getByRole("combobox", { name: settings.protocol }))
    await screen.findByRole("option", { name: settings.opencodeV2Protocol })
    expect(screen.queryByRole("option", { name: "OpenCode (HTTP + SSE)" })).toBeNull()
  })

  it("shows the auto-spawn toggle and opencode fields when the form holds the opencode protocol", () => {
    // OpenCode V1 is no longer selectable (only a stored/preset value can carry
    // it), so drive it through the form state the select would have written.
    render(<Harness presetId="claude-code" />)
    act(() => {
      form().setData((current) => ({ ...current, protocol: "opencode", transport: "sse" }))
    })

    expect(readout()).toMatchObject({ protocol: "opencode", transport: "sse" })
    expect(screen.getByRole("switch", { name: manager.autoSpawnServer })).toBeInTheDocument()
    expect(screen.getByLabelText(manager.serverPassword!)).toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: settings.passBareFlag })).not.toBeInTheDocument()
  })

  it("shows the endpoint field for opencode with auto-spawn off, and the launch fields with it on", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    act(() => {
      form().setData((current) => ({
        ...current,
        protocol: "opencode",
        transport: "sse",
        autoSpawnServer: false,
      }))
    })

    expect(screen.getByLabelText(settings.endpoint!)).toBeInTheDocument()
    expect(screen.queryByLabelText(manager.serverPort!)).not.toBeInTheDocument()

    await user.click(screen.getByRole("switch", { name: manager.autoSpawnServer }))

    expect(readout()).toMatchObject({ autoSpawnServer: true })
    expect(screen.queryByLabelText(settings.endpoint!)).not.toBeInTheDocument()
    expect(screen.getByLabelText(settings.command!)).toBeInTheDocument()
    expect(screen.getByLabelText(manager.serverPort!)).toBeInTheDocument()
  })

  it("shows the plane warning beside the auto-spawn launch fields", () => {
    render(<Harness presetId="opencode-server" planeWarning="No host here." />)

    expect(readout()).toMatchObject({ protocol: "opencode", autoSpawnServer: true })
    expect(
      screen.getByText(`${manager.opencodeAutoSpawnNeedsAProcess} No host here.`)
    ).toBeInTheDocument()
  })

  it("shows the plane warning next to the stdio fields", () => {
    render(<Harness presetId="claude-code" planeWarning="No host here." />)

    expect(screen.getByText(`${manager.stdioNeedsAProcess} No host here.`)).toBeInTheDocument()
  })

  it("omits the plane warning when there is none", () => {
    render(<Harness presetId="claude-code" />)
    expect(screen.queryByText(manager.stdioNeedsAProcess!, { exact: false })).toBeNull()
  })

  it("shows the endpoint field for a non-stdio, non-opencode transport", () => {
    render(<Harness />)
    act(() => {
      form().setData((current) => ({ ...current, protocol: "a2a", transport: "http" }))
    })
    expect(screen.getByLabelText(settings.endpoint!)).toBeInTheDocument()
    expect(screen.queryByLabelText(settings.command!)).not.toBeInTheDocument()
  })

  it("shows working directory and the environment editor for a direct-environment preset", () => {
    expect(getPresetConfig("qoder")).not.toBeNull()
    render(<Harness presetId="qoder" />)

    expect(screen.getByLabelText(settings.workingDirectory!)).toBeInTheDocument()
    expect(screen.getByText(settings.qoderEnvironment!)).toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: settings.passBareFlag })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: settings.passDebugFlag })).not.toBeInTheDocument()
    // The generic, folded process-environment section is replaced, not doubled.
    expect(screen.queryByText(settings.processEnvironment!)).not.toBeInTheDocument()
  })

  it("treats the aider-cli protocol as direct-environment without a preset", () => {
    render(<Harness />)
    act(() => {
      form().setData((current) => ({ ...current, protocol: "aider-cli", transport: "stdio" }))
    })
    expect(screen.getByText(settings.aiderEnvironment!)).toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: settings.passBareFlag })).not.toBeInTheDocument()
  })

  it("folds the process environment behind a collapsible for ordinary stdio presets", async () => {
    const user = userEvent.setup()
    render(<Harness presetId="claude-code" />)

    const trigger = screen.getByRole("button", { name: settings.processEnvironment })
    expect(screen.queryByLabelText(settings.workingDirectory!)).not.toBeInTheDocument()
    await user.click(trigger)
    expect(screen.getByLabelText(settings.workingDirectory!)).toBeInTheDocument()
  })

  it("stacks protocol and transport on a phone and puts them side by side from sm", () => {
    render(<Harness presetId="claude-code" />)

    const protocol = screen.getByRole("combobox", { name: settings.protocol })
    const transport = screen.getByRole("combobox", { name: settings.transport })
    const container = protocol.parentElement!.parentElement!
    expect(container).toBe(transport.parentElement!.parentElement)
    expect(container).toHaveClass("grid", "sm:grid-cols-2")
    expect(container).not.toHaveClass("grid-cols-2")
  })
})
