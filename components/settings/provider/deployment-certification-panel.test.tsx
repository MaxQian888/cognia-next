import { render, screen } from "@testing-library/react"

import { PINNED_RUNTIME_VERSIONS } from "@cognia/agent-config-types/runtime-versions"

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
      // Track the real pin, not a literal. The panel computes freshness
      // against PINNED_RUNTIME_VERSIONS, so a hardcoded version turns "this
      // record is current" into "this record was current in July" and the
      // freshness assertion below starts failing on the next SDK bump —
      // which is exactly what it did at 0.3.183 -> 0.3.220.
      agentSdkVersion: PINNED_RUNTIME_VERSIONS.agentSdkVersion,
      claudeCodeVersion: "2.1.0",
      gatewayVersion: PINNED_RUNTIME_VERSIONS.gatewayCrateVersion,
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

  it("defaults the Claude Code / suite axes to the pinned runtime versions", () => {
    // A record keyed with the real pins must read fresh with NO version props —
    // the previous defaults ("unknown" / "1") never matched and every certified
    // bundle rendered as stale.
    liveQueryResults.push([
      {
        ...record,
        manifest: {
          ...record.manifest,
          key: {
            ...record.manifest.key,
            claudeCodeVersion: PINNED_RUNTIME_VERSIONS.claudeCodeVersion,
            suiteVersion: PINNED_RUNTIME_VERSIONS.certificationSuiteVersion,
          },
        },
      },
    ])
    render(<DeploymentCertificationPanel deploymentRef="dep-1" />)
    expect(screen.getByText("certificationFresh")).toBeInTheDocument()
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
