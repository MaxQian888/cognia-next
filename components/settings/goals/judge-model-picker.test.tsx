import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { JudgeModelPicker } from "./judge-model-picker"

// next-intl mocked to echo the key so assertions are deterministic.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

type AnySettings = Record<string, unknown>
const stateRef: { current: { settings: AnySettings } } = {
  current: {
    settings: {
      providerSettings: {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-4o-mini",
          enabledModels: ["gpt-4o-mini", "gpt-4.1"],
        },
      },
      customProviders: [],
    },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: stateRef.current.settings }),
}))

beforeEach(() => {
  stateRef.current = {
    settings: {
      providerSettings: {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-4o-mini",
          enabledModels: ["gpt-4o-mini", "gpt-4.1"],
        },
      },
      customProviders: [],
    },
  }
})

describe("JudgeModelPicker", () => {
  it("labels the trigger with the selected model", () => {
    render(<JudgeModelPicker model="gpt-4o-mini" provider="openai" onChange={jest.fn()} />)
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-judge-model-invalid")).not.toBeInTheDocument()
  })

  it("falls back to the inherit-chat-model label when unset", () => {
    render(<JudgeModelPicker onChange={jest.fn()} />)
    expect(screen.getByText("judge.useChatModel")).toBeInTheDocument()
  })

  it("opening the popover lists the provider's models", async () => {
    const user = userEvent.setup()
    render(<JudgeModelPicker onChange={jest.fn()} />)
    await user.click(screen.getByRole("button", { name: "judge.model" }))
    expect(screen.getByText("gpt-4.1")).toBeInTheDocument()
  })

  it("selecting a model reports the provider+model pair", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(<JudgeModelPicker onChange={onChange} />)
    await user.click(screen.getByRole("button", { name: "judge.model" }))
    await user.click(screen.getByText("gpt-4.1"))
    expect(onChange).toHaveBeenCalledWith({ model: "gpt-4.1", provider: "openai" })
  })

  it("clearing reports an empty selection (inherit chat model)", async () => {
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(<JudgeModelPicker model="gpt-4o-mini" provider="openai" onChange={onChange} />)
    await user.click(screen.getByRole("button", { name: "judge.model" }))
    await user.click(screen.getByText("judge.useChatModel"))
    expect(onChange).toHaveBeenCalledWith({ model: undefined, provider: undefined })
  })

  it("flags a stored model that no configured provider offers", () => {
    render(<JudgeModelPicker model="ghost-model" provider="openai" onChange={jest.fn()} />)
    expect(screen.getByTestId("goal-judge-model-invalid")).toBeInTheDocument()
    expect(screen.getByText("judge.invalidModel")).toBeInTheDocument()
  })

  it("groups options by provider (renders a separator between groups)", async () => {
    stateRef.current = {
      settings: {
        providerSettings: {
          openai: {
            providerId: "openai",
            enabled: true,
            defaultModel: "gpt-4o-mini",
            enabledModels: ["gpt-4o-mini"],
          },
          anthropic: {
            providerId: "anthropic",
            enabled: true,
            defaultModel: "claude-haiku-4-5",
            enabledModels: ["claude-haiku-4-5"],
          },
        },
        customProviders: [],
      },
    }
    const user = userEvent.setup()
    render(<JudgeModelPicker onChange={jest.fn()} />)
    await user.click(screen.getByRole("button", { name: "judge.model" }))
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument()
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument()
  })

  it("shows the empty notice when every provider is disabled", async () => {
    stateRef.current = {
      settings: {
        providerSettings: { anthropic: { providerId: "anthropic", enabled: false } },
        customProviders: [],
      },
    }
    const user = userEvent.setup()
    render(<JudgeModelPicker onChange={jest.fn()} />)
    await user.click(screen.getByRole("button", { name: "judge.model" }))
    expect(screen.getByText("judge.noModels")).toBeInTheDocument()
  })
})
