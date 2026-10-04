/**
 * @jest-environment jsdom
 */
import { useEffect } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"
import { useAddAgentForm, type AddAgentFormState } from "@/hooks/agent/use-add-agent-form"
import { DEFAULT_TIMEOUT_MS } from "@/lib/ai/agent/external/config/add-agent-form"

import { AddAgentCogniaModelField, ExecutionTuningFields } from "./execution-tuning-fields"

jest.mock("../cognia-model-picker", () => ({
  CogniaModelPicker: jest.fn(
    ({ onChange }: { onChange: (binding: unknown) => void; config: unknown }) => (
      <button
        type="button"
        onClick={() => onChange({ providerId: "provider-x", modelId: "model-y" })}
      >
        pick model fixture
      </button>
    )
  ),
}))

import { CogniaModelPicker } from "../cognia-model-picker"

const pickerMock = CogniaModelPicker as unknown as jest.Mock

const settings = en.externalAgent.settings as unknown as Record<string, string>
const manager = en.externalAgent.manager as unknown as Record<string, string>

let latestForm: AddAgentFormState | null = null

function Harness({
  presetId = "",
  collapsible,
  withModel = false,
}: {
  presetId?: string
  collapsible?: boolean
  withModel?: boolean
}) {
  const form = useAddAgentForm(presetId)
  useEffect(() => {
    latestForm = form
  })
  return (
    <>
      <ExecutionTuningFields form={form} collapsible={collapsible} />
      {withModel && <AddAgentCogniaModelField form={form} />}
    </>
  )
}

function form(): AddAgentFormState {
  if (!latestForm) throw new Error("harness not rendered")
  return latestForm
}

type PickerConfig = {
  protocol: string
  transport: string
  process: { command: string; args: string[] }
  network?: { endpoint: string }
  metadata: Record<string, unknown>
}

function lastPickerProps(): { config: PickerConfig; value: unknown } {
  const calls = pickerMock.mock.calls
  return calls[calls.length - 1]![0] as { config: PickerConfig; value: unknown }
}

beforeEach(() => {
  latestForm = null
  pickerMock.mockClear()
})

describe("ExecutionTuningFields", () => {
  it("keeps the inputs folded until the trigger is clicked", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const fields = screen.getByTestId("add-agent-tuning-fields")
    expect(fields.tagName).not.toBe("FIELDSET")
    expect(screen.queryByLabelText(settings.executionTimeoutMs!)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: manager.advancedOptions }))

    expect(screen.getByLabelText(settings.executionTimeoutMs!)).toBeVisible()
    expect(screen.getByLabelText(settings.maxRetries!)).toBeVisible()
    expect(screen.getByLabelText(settings.retryDelayMs!)).toBeVisible()
    expect(screen.getByLabelText(settings.maxRetryDelayMs!)).toBeVisible()
    expect(screen.getByLabelText(settings.retryErrorPatterns!)).toBeVisible()
  })

  it("renders an always-open fieldset when collapsible is false", () => {
    render(<Harness collapsible={false} />)

    const fields = screen.getByTestId("add-agent-tuning-fields")
    expect(fields.tagName).toBe("FIELDSET")
    expect(screen.getByRole("group", { name: manager.advancedOptions })).toBe(fields)
    expect(screen.queryByRole("button", { name: manager.advancedOptions })).toBeNull()
    expect(screen.getByLabelText(settings.executionTimeoutMs!)).toBeVisible()
    expect(screen.getByLabelText(settings.executionTimeoutMs!)).toHaveValue(
      Number(DEFAULT_TIMEOUT_MS)
    )
  })

  it("writes edited values back into the form", () => {
    render(<Harness collapsible={false} />)

    fireEvent.change(screen.getByLabelText(settings.executionTimeoutMs!), {
      target: { value: "60000" },
    })
    fireEvent.change(screen.getByLabelText(settings.maxRetries!), { target: { value: "5" } })
    fireEvent.change(screen.getByLabelText(settings.retryErrorPatterns!), {
      target: { value: "ECONNRESET" },
    })

    expect(form().data).toMatchObject({
      timeoutMs: "60000",
      retryMaxRetries: "5",
      retryOnErrors: "ECONNRESET",
    })
  })

  it("switches the backoff strategy through the select", async () => {
    const user = userEvent.setup()
    render(<Harness collapsible={false} />)
    expect(form().data.retryExponentialBackoff).toBe(true)

    await user.click(screen.getByRole("combobox", { name: settings.backoffStrategy }))
    await user.click(await screen.findByRole("option", { name: settings.backoffFixedDelay }))

    expect(form().data.retryExponentialBackoff).toBe(false)
  })
})

describe("AddAgentCogniaModelField", () => {
  it("hands the picker a stdio config derived from the form", () => {
    render(<Harness withModel />)
    act(() => {
      form().setData((current) => ({
        ...current,
        protocol: "acp",
        transport: "stdio",
        command: "my-agent",
        args: '--flag "two words"',
        endpoint: "http://ignored",
      }))
    })

    const { config, value } = lastPickerProps()
    expect(config.protocol).toBe("acp")
    expect(config.transport).toBe("stdio")
    expect(config.process.command).toBe("my-agent")
    expect(config.process.args).toEqual(["--flag", "two words"])
    expect(config.network).toBeUndefined()
    expect(config.metadata).toMatchObject({ autoSpawnServer: false })
    expect(value).toBeUndefined()
  })

  it("defaults the command to opencode for an auto-spawned server", () => {
    render(<Harness withModel />)
    act(() => {
      form().setData((current) => ({
        ...current,
        protocol: "opencode",
        transport: "sse",
        command: "",
        args: "",
        autoSpawnServer: true,
      }))
    })

    const { config } = lastPickerProps()
    expect(config.process).toEqual({ command: "opencode", args: [] })
    expect(config.network).toBeUndefined()
    expect(config.metadata).toMatchObject({ autoSpawnServer: true })
  })

  it("passes the endpoint for a network transport and an empty argv for unparsable args", () => {
    render(<Harness withModel />)
    act(() => {
      form().setData((current) => ({
        ...current,
        protocol: "a2a",
        transport: "http",
        endpoint: "http://127.0.0.1:9000",
        args: '"unterminated',
      }))
    })

    const { config } = lastPickerProps()
    expect(config.network).toEqual({ endpoint: "http://127.0.0.1:9000" })
    expect(config.process.args).toEqual([])
  })

  it("merges the preset's metadata", () => {
    render(<Harness presetId="deepseek-harness-readonly" withModel />)
    const { config } = lastPickerProps()
    expect(config.metadata).toMatchObject({ requiresManagedRuntime: true, autoSpawnServer: false })
  })

  it("stores the picked binding in the form and feeds it back as the value", async () => {
    const user = userEvent.setup()
    render(<Harness withModel />)

    await user.click(screen.getByRole("button", { name: "pick model fixture" }))

    expect(form().data.cogniaModel).toEqual({ providerId: "provider-x", modelId: "model-y" })
    expect(lastPickerProps().value).toEqual({ providerId: "provider-x", modelId: "model-y" })
  })
})
