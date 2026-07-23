/** @jest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { DeploymentAgentSdkCard } from "./deployment-agent-sdk-card"

const FLAG_KEY = "cognia-agent-execution-flags-v1"

function enableFlag() {
  window.localStorage.setItem(
    FLAG_KEY,
    JSON.stringify({ experimentalAnthropicDeploymentAgentSdk: true })
  )
}

describe("DeploymentAgentSdkCard", () => {
  beforeEach(() => window.localStorage.clear())

  it("is hidden while the experimental flag is off", () => {
    const { container } = render(
      <DeploymentAgentSdkCard
        providerId="my-relay"
        protocol="anthropic"
        enabled={false}
        onChange={jest.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("is hidden for non-anthropic protocols even with the flag on", () => {
    enableFlag()
    const { container } = render(
      <DeploymentAgentSdkCard
        providerId="openai"
        protocol="openai"
        enabled={false}
        onChange={jest.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the experimental badge + consequence copy and toggles the POLICY only", () => {
    enableFlag()
    const onChange = jest.fn()
    render(
      <DeploymentAgentSdkCard
        providerId="my-relay"
        protocol="anthropic"
        enabled={false}
        onChange={onChange}
      />
    )
    expect(screen.getByText("agentSdkExperimentalBadge")).toBeInTheDocument()
    expect(screen.getByText("agentSdkExperimentalConsequence")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).toHaveBeenCalledWith(true)
    // No compatibility/certification storage is touched by this card: the
    // only side channel is the onChange policy write.
    expect(Object.keys(window.localStorage)).toEqual([FLAG_KEY])
  })
})
