/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { CustomProviderSettings } from "@cognia/provider-types/provider"

import { CustomProviderInlineConfig } from "./provider-custom-inline-config"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

// The real gate takes the reveal callback and runs it only when biometrics
// allow (or are not required). `allowReveal` stands in for that decision.
let allowReveal = true
const revealSecret = jest.fn(async (reveal: () => void) => {
  if (allowReveal) reveal()
  return allowReveal ? "revealed" : "denied"
})
jest.mock("@/hooks/use-secret-reveal", () => ({ useSecretReveal: () => revealSecret }))

function makeProvider(over: Partial<CustomProviderSettings> = {}): CustomProviderSettings {
  return {
    id: "my-gateway",
    name: "my-gateway",
    customName: "My Gateway",
    apiProtocol: "openai",
    apiKey: "sk-secret-value",
    baseURL: "https://gw.example/v1",
    enabled: true,
    ...over,
  } as CustomProviderSettings
}

const noop = () => {}
const baseProps = {
  onApiKeyChange: noop,
  onBaseURLChange: noop,
  onDefaultModelChange: noop,
  onEditClick: noop,
  onTestConnection: noop,
}

beforeEach(() => {
  allowReveal = true
  revealSecret.mockClear()
})

describe("CustomProviderInlineConfig", () => {
  it("shows the protocol the endpoint speaks", () => {
    render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} />)
    expect(screen.getByText("openai")).toBeInTheDocument()
  })

  // The key is written to the `customProviders` row, not the `providerSettings`
  // map. Reading from the wrong source resets the input on every keystroke.
  it("renders the key stored on the custom provider row", () => {
    render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} />)
    const input = screen.getByDisplayValue("sk-secret-value")
    expect(input).toHaveAttribute("type", "password")
  })

  it("keeps the endpoint from the same row", () => {
    render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} />)
    expect(screen.getByDisplayValue("https://gw.example/v1")).toBeInTheDocument()
  })

  it("survives a row with no credentials yet", () => {
    render(
      <CustomProviderInlineConfig
        cp={makeProvider({ apiKey: undefined, baseURL: undefined })}
        {...baseProps}
      />
    )
    expect(screen.getByText("configTab.notVerifiedHint")).toBeInTheDocument()
  })

  describe("test status", () => {
    it("says nothing has been verified before a test runs", () => {
      render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} testResult={null} />)
      expect(screen.getByText("configTab.notVerifiedHint")).toBeInTheDocument()
      expect(screen.queryByTestId("custom-provider-test-result")).not.toBeInTheDocument()
    })

    it("reports a pass", () => {
      render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} testResult="success" />)
      expect(screen.getByTestId("custom-provider-test-result")).toHaveTextContent(
        "customTestSuccess"
      )
    })

    // The hook carried the provider's real error text from the start and the
    // UI never rendered it, so every failed custom test just said "failed".
    it("surfaces the provider's own error text on a failure", () => {
      render(
        <CustomProviderInlineConfig
          cp={makeProvider()}
          {...baseProps}
          testResult="error"
          testMessage="404 model not found"
        />
      )
      expect(screen.getByTestId("custom-provider-test-message")).toHaveTextContent(
        "404 model not found"
      )
    })

    it("does not append the detail message to a pass", () => {
      render(
        <CustomProviderInlineConfig
          cp={makeProvider()}
          {...baseProps}
          testResult="success"
          testMessage="3 models"
        />
      )
      expect(screen.queryByTestId("custom-provider-test-message")).not.toBeInTheDocument()
    })

    it("reads limited as neither a pass nor a failure", () => {
      render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} testResult="limited" />)
      const status = screen.getByTestId("custom-provider-test-result")
      expect(status).toHaveTextContent("customTestLimited")
      expect(status).not.toHaveTextContent("customTestSuccess")
      expect(status).not.toHaveTextContent("customTestError")
    })
  })

  it("disables the test button while a test is in flight", () => {
    render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} isTesting />)
    expect(screen.getByTestId("custom-provider-test")).toBeDisabled()
  })

  it("runs a test on demand", async () => {
    const onTestConnection = jest.fn()
    const user = userEvent.setup()
    render(
      <CustomProviderInlineConfig
        cp={makeProvider()}
        {...baseProps}
        onTestConnection={onTestConnection}
      />
    )
    await user.click(screen.getByTestId("custom-provider-test"))
    expect(onTestConnection).toHaveBeenCalledTimes(1)
  })

  // Settings, Security, "Require biometrics to reveal secrets" gates this.
  it("asks the reveal gate before showing the key", async () => {
    const user = userEvent.setup()
    render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} />)

    await user.click(screen.getByTestId("custom-provider-toggle-key"))

    expect(revealSecret).toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByDisplayValue("sk-secret-value")).toHaveAttribute("type", "text")
    )
  })

  it("keeps the key masked when the reveal gate refuses", async () => {
    allowReveal = false
    const user = userEvent.setup()
    render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} />)

    await user.click(screen.getByTestId("custom-provider-toggle-key"))

    expect(revealSecret).toHaveBeenCalled()
    expect(screen.getByDisplayValue("sk-secret-value")).toHaveAttribute("type", "password")
  })

  it("re-masks the key without asking the gate again", async () => {
    const user = userEvent.setup()
    render(<CustomProviderInlineConfig cp={makeProvider()} {...baseProps} />)

    await user.click(screen.getByTestId("custom-provider-toggle-key"))
    await waitFor(() =>
      expect(screen.getByDisplayValue("sk-secret-value")).toHaveAttribute("type", "text")
    )
    await user.click(screen.getByTestId("custom-provider-toggle-key"))

    expect(screen.getByDisplayValue("sk-secret-value")).toHaveAttribute("type", "password")
    expect(revealSecret).toHaveBeenCalledTimes(1)
  })

  it("offers a default-model picker once the provider lists models", () => {
    render(
      <CustomProviderInlineConfig
        cp={makeProvider({
          customModels: ["gpt-4.1", "o3"],
          customModelMetadata: { "gpt-4.1": { name: "GPT-4.1" } },
        } as unknown as Partial<CustomProviderSettings>)}
        {...baseProps}
      />
    )
    expect(screen.getByRole("combobox", { name: "defaultModel" })).toBeInTheDocument()
  })

  // A custom provider with no discovered models has nothing to choose from, so
  // the block is absent rather than an empty dropdown.
  it("hides the default-model block when the provider lists no models", () => {
    render(<CustomProviderInlineConfig cp={makeProvider({ customModels: [] })} {...baseProps} />)
    expect(screen.queryByRole("combobox", { name: "defaultModel" })).not.toBeInTheDocument()
  })
})

it("uses vault readiness for testing without putting the readiness digest in the editable key field", () => {
  render(
    <CustomProviderInlineConfig
      cp={{ ...makeProvider(), apiKey: undefined }}
      {...baseProps}
      hasSubscriptionCredential
      canTestConnection
    />
  )
  expect(screen.getByTestId("custom-provider-api-key-input")).toHaveValue("")
  expect(screen.getByText("configTab.subscriptionCredentialDescription")).toBeInTheDocument()
  expect(screen.getByTestId("custom-provider-test")).toBeEnabled()
})

it("disables connection testing when the subscription credential is unavailable", () => {
  render(
    <CustomProviderInlineConfig
      cp={{ ...makeProvider(), apiKey: undefined }}
      {...baseProps}
      canTestConnection={false}
    />
  )
  expect(screen.getByTestId("custom-provider-test")).toBeDisabled()
})
