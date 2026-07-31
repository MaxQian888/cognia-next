import { render, screen } from "@testing-library/react"

// useLiveQuery is mocked per-call: the card issues three queries in order
// (deployment → provider → transport); the mock replays a scripted sequence.
const liveQueryResults: unknown[] = []
let liveQueryCall = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(() => liveQueryResults[liveQueryCall++ % liveQueryResults.length]),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    deploymentProfiles: { where: jest.fn() },
    providerProfiles: { get: jest.fn() },
    transportProfiles: { get: jest.fn() },
  })),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

import { DeploymentProfileCard } from "./deployment-profile-card"

const relayDeployment = {
  id: "glm-anthropic",
  providerRef: "zhipu",
  endpoint: "https://open.bigmodel.cn/api/anthropic",
  transportProfileRef: "tp-anthropic-x-api-key",
  credentialProfileRef: { kind: "legacy-provider-settings", providerId: "glm-anthropic" },
  models: [{ id: "glm-4.6" }],
  legacyProviderId: "glm-anthropic",
}

function scriptQueries(deployment: unknown, provider: unknown, transport: unknown) {
  liveQueryResults.length = 0
  liveQueryResults.push(deployment, provider, transport)
  liveQueryCall = 0
}

describe("DeploymentProfileCard", () => {
  it("renders nothing while no derived deployment exists", () => {
    scriptQueries(undefined, undefined, undefined)
    const { container } = render(<DeploymentProfileCard providerId="unknown" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the derived chain with a vendor badge for relays and the credential KIND only", () => {
    scriptQueries(
      relayDeployment,
      { id: "zhipu", displayName: "Zhipu", deploymentRefs: ["glm-anthropic"] },
      { id: "tp-anthropic-x-api-key", protocol: "anthropic", auth: { scheme: "x-api-key" } }
    )
    render(<DeploymentProfileCard providerId="glm-anthropic" />)

    expect(screen.getByText("deploymentProfileTitle")).toBeInTheDocument()
    expect(screen.getByText("deploymentProfileVendorOf:Zhipu")).toBeInTheDocument()
    expect(screen.getByText("https://open.bigmodel.cn/api/anthropic")).toBeInTheDocument()
    expect(screen.getByText("anthropic · x-api-key")).toBeInTheDocument()
    expect(
      screen.getByText("deploymentProfileCredentialKind_legacy_provider_settings")
    ).toBeInTheDocument()
    // No secret material anywhere in the DOM.
    expect(document.body.innerHTML).not.toMatch(/sk-|apiKey/)
  })

  it("omits the vendor badge for non-relay deployments and tolerates a missing transport", () => {
    scriptQueries(
      {
        ...relayDeployment,
        id: "zhipu",
        providerRef: "zhipu",
        legacyProviderId: "zhipu",
        credentialProfileRef: undefined,
      },
      { id: "zhipu", displayName: "Zhipu", deploymentRefs: [] },
      undefined
    )
    render(<DeploymentProfileCard providerId="zhipu" />)

    expect(screen.queryByText(/deploymentProfileVendorOf/)).not.toBeInTheDocument()
    expect(screen.getByText("tp-anthropic-x-api-key")).toBeInTheDocument()
    expect(screen.queryByText("deploymentProfileCredential")).not.toBeInTheDocument()
  })
})
