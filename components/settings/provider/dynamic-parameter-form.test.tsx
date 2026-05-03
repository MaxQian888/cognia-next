import { render, screen, fireEvent } from "@testing-library/react"
import { DynamicParameterForm } from "./dynamic-parameter-form"
import type { ParameterDefinition, ModelConfig } from "@/types/provider"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const sliderParam: ParameterDefinition = {
  key: "temperature",
  type: "slider",
  label: "providerParams.temperature.label",
  description: "providerParams.temperature.description",
  category: "inference",
  defaultValue: 0.7,
  validation: { min: 0, max: 2, step: 0.1 },
}

const selectParam: ParameterDefinition = {
  key: "openai.reasoningEffort",
  type: "select",
  label: "providerParams.openai.reasoningEffort.label",
  description: "providerParams.openai.reasoningEffort.description",
  category: "provider-specific",
  defaultValue: "medium",
  validation: {
    options: [
      { value: "low", label: "providerParams.openai.reasoningEffort.low" },
      { value: "medium", label: "providerParams.openai.reasoningEffort.medium" },
      { value: "high", label: "providerParams.openai.reasoningEffort.high" },
    ],
  },
  condition: { modelCapability: "supportsReasoning" },
}

const toggleParam: ParameterDefinition = {
  key: "openai.store",
  type: "toggle",
  label: "providerParams.openai.store.label",
  description: "providerParams.openai.store.description",
  category: "advanced",
  defaultValue: false,
}

// json type implemented in Task 4
const jsonParam: ParameterDefinition = {
  key: "openai.schema",
  type: "json",
  label: "providerParams.openai.schema.label",
  description: "providerParams.openai.schema.description",
  category: "advanced",
  defaultValue: {},
}

const numberParam: ParameterDefinition = {
  key: "connection.timeout",
  type: "number",
  label: "providerParams.connection.timeout.label",
  description: "providerParams.connection.timeout.description",
  category: "connection",
  defaultValue: 30000,
  validation: { min: 1000, max: 300000 },
}

describe("DynamicParameterForm", () => {
  it("renders slider parameters", () => {
    render(<DynamicParameterForm parameters={[sliderParam]} values={{}} onChange={jest.fn()} />)
    expect(screen.getByText("temperature.label")).toBeInTheDocument()
  })

  it("renders toggle parameters", () => {
    render(<DynamicParameterForm parameters={[toggleParam]} values={{}} onChange={jest.fn()} />)
    expect(screen.getByText("openai.store.label")).toBeInTheDocument()
  })

  it("hides parameters when condition not met", () => {
    const model: ModelConfig = {
      id: "gpt-4o",
      name: "GPT-4o",
      contextLength: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsAudio: false,
      supportsVideo: false,
      supportsStreaming: true,
      supportsReasoning: false,
    }
    render(
      <DynamicParameterForm
        parameters={[selectParam]}
        values={{}}
        onChange={jest.fn()}
        modelConfig={model}
      />
    )
    expect(screen.queryByText("openai.reasoningEffort.label")).not.toBeInTheDocument()
  })

  it("shows parameters when condition met", () => {
    const model: ModelConfig = {
      id: "o3",
      name: "o3",
      contextLength: 200000,
      supportsTools: true,
      supportsVision: true,
      supportsAudio: false,
      supportsVideo: false,
      supportsStreaming: true,
      supportsReasoning: true,
    }
    render(
      <DynamicParameterForm
        parameters={[selectParam]}
        values={{}}
        onChange={jest.fn()}
        modelConfig={model}
      />
    )
    expect(screen.getByText("openai.reasoningEffort.label")).toBeInTheDocument()
  })

  it("filters by category", () => {
    render(
      <DynamicParameterForm
        parameters={[sliderParam, selectParam, toggleParam]}
        values={{}}
        onChange={jest.fn()}
        filterCategory="inference"
      />
    )
    expect(screen.getByText("temperature.label")).toBeInTheDocument()
    expect(screen.queryByText("openai.reasoningEffort.label")).not.toBeInTheDocument()
    expect(screen.queryByText("openai.store.label")).not.toBeInTheDocument()
  })

  // json type implemented in Task 4
  it("renders json parameters as textarea", () => {
    render(<DynamicParameterForm parameters={[jsonParam]} values={{}} onChange={jest.fn()} />)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  // json type implemented in Task 4
  it("shows error on invalid JSON blur", async () => {
    render(<DynamicParameterForm parameters={[jsonParam]} values={{}} onChange={jest.fn()} />)
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "{invalid" } })
    fireEvent.blur(textarea)
    expect(await screen.findByText("invalidJson")).toBeInTheDocument()
  })

  it("shows error when number exceeds max", async () => {
    render(<DynamicParameterForm parameters={[numberParam]} values={{}} onChange={jest.fn()} />)
    const input = screen.getByRole("spinbutton")
    fireEvent.change(input, { target: { value: "999999", valueAsNumber: 999999 } })
    expect(await screen.findByText(/outOfRange/)).toBeInTheDocument()
  })
})
