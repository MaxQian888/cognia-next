import { render, screen } from "@testing-library/react"

const liveQueryResults: unknown[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(() => liveQueryResults[0]),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({ agentCompatibilityRecords: { where: jest.fn() } })),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { DeploymentCertificationPanel } from "./deployment-certification-panel"

const record = {
  keyId: "k1",
  bundleId: "bundle-a",
  deploymentRef: "dep-1",
  evidence: "cognia-verified",
  level: "core",
  issuer: "cognia-ci",
  issuedAt: "2026-07-23T00:00:00.000Z",
  manifest: {
    manifestVersion: 1,
    bundleId: "bundle-a",
    key: {
      runtime: "claude-agent-sdk",
      ingressProtocol: "anthropic",
      routeMode: "gateway",
      translationMode: "passthrough",
      deploymentRef: "dep-1",
      model: "claude-opus-4-8",
      agentSdkVersion: "0.3.183",
      claudeCodeVersion: "2.1.0",
      gatewayVersion: "0.1.0",
      suiteVersion: "1",
    },
    evidence: "cognia-verified",
    level: "core",
    capabilities: { streaming: "supported", "prompt-caching": "unsupported" },
    suiteResults: [],
    parity: { passed: true },
    knownLosses: [],
    issuer: "cognia-ci",
    issuedAt: "2026-07-23T00:00:00.000Z",
  },
}

describe("DeploymentCertificationPanel", () => {
  beforeEach(() => {
    liveQueryResults.length = 0
  })

  it("renders nothing without records", () => {
    liveQueryResults.push([])
    const { container } = render(<DeploymentCertificationPanel deploymentRef="dep-1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows evidence, capability table, and freshness for a current record", () => {
    liveQueryResults.push([record])
    render(
      <DeploymentCertificationPanel
        deploymentRef="dep-1"
        claudeCodeVersion="2.1.0"
        suiteVersion="1"
      />
    )
    expect(screen.getByText("certificationEvidence_cognia_verified")).toBeInTheDocument()
    expect(screen.getByText("certificationFresh")).toBeInTheDocument()
    expect(screen.getByText("streaming")).toBeInTheDocument()
    expect(screen.getByText("certificationSupport_unsupported")).toBeInTheDocument()
    expect(screen.getByText("bundle-a")).toBeInTheDocument()
  })

  it("marks a version-drifted record stale with reasons and the rollback hint", () => {
    liveQueryResults.push([record])
    render(
      <DeploymentCertificationPanel
        deploymentRef="dep-1"
        claudeCodeVersion="9.9.9"
        suiteVersion="1"
      />
    )
    expect(screen.getByText("certificationStale")).toBeInTheDocument()
    expect(screen.getByText(/claudeCodeVersion/)).toBeInTheDocument()
    expect(screen.getByText("certificationRollbackHint")).toBeInTheDocument()
  })
})
