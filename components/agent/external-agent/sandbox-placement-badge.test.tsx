import { act, fireEvent, render, screen } from "@testing-library/react"

import { SandboxPlacementBadge } from "./sandbox-placement-badge"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  __resetPlacementReportsForTests,
  recordPlacementReport,
} from "@/lib/sandbox/placement-report"
import {
  __resetRunEnvironmentForTests,
  recordRunEnvironmentOutcome,
} from "@/lib/sandbox/run-environment"
import en from "@/i18n/messages/en/externalAgent.json"
import pe from "@/i18n/messages/en/projectEnvironment.json"

jest.mock("@/lib/tauri/events", () => ({
  // No placement channel in this suite: reports are recorded directly.
  onTauriEvent: async () => () => {},
}))

beforeEach(() => {
  __resetPlacementReportsForTests()
  __resetRunEnvironmentForTests()
})

function renderBadge(agentId = "a1") {
  return render(
    <TooltipProvider delayDuration={0}>
      <SandboxPlacementBadge agentId={agentId} />
    </TooltipProvider>
  )
}

async function tooltipText(testId: string): Promise<string> {
  const badge = screen.getByTestId(testId)
  await act(async () => {
    fireEvent.pointerMove(badge)
    fireEvent.focus(badge)
  })
  return (await screen.findAllByRole("tooltip")).map((node) => node.textContent).join("\n")
}

describe("SandboxPlacementBadge", () => {
  // Q39: an agent that never asked for a runtime environment carries no trace
  // of the feature.
  it("renders nothing for an agent that asked for nothing", () => {
    const { container } = renderBadge()
    expect(container).toBeEmptyDOMElement()

    act(() => recordRunEnvironmentOutcome("a1", { kind: "off" }))
    expect(container).toBeEmptyDOMElement()
  })

  it("names the tier the Host attested, and the details it reported", async () => {
    act(() =>
      recordPlacementReport({
        agentId: "a1",
        kind: "sandbox",
        image: `ghcr.io/acme/dev@sha256:${"a".repeat(64)}`,
        tier: "gvisor",
        user: "node",
        userRemapped: true,
        bundleReleaseTag: "v1.2.3",
        libc: "musl",
        egressTier: "allowlist",
        egressEnforced: false,
        credentialsMode: "none",
      })
    )
    renderBadge()

    expect(screen.getByTestId("sandbox-placement-sandboxed")).toHaveTextContent("Sandbox · gVisor")
    const text = await tooltipText("sandbox-placement-sandboxed")
    expect(text).toContain(`Image: ghcr.io/acme/dev@sha256:${"a".repeat(64)}`)
    expect(text).toContain("Runs as node, remapped onto the workspace owner")
    expect(text).toContain("Agent bundle: v1.2.3 (musl)")
    // Rule 7: the Step ① egress gap is stated on the run, not implied away,
    // and the credentials line reports that none rode in.
    expect(text).toContain("Network: allowlist, recorded but not enforced")
    expect(text).toContain("Credentials: none")
  })

  // A Host that did not say whether egress is enforced has not said it is
  // unenforced either.
  it("says nothing about egress when the Host said nothing", async () => {
    act(() =>
      recordPlacementReport({ agentId: "a1", kind: "sandbox", tier: "container", user: "root" })
    )
    renderBadge()
    const text = await tooltipText("sandbox-placement-sandboxed")
    expect(text).not.toContain("Network:")
  })

  it("reads 'Sandbox' when the Host did not name a tier", () => {
    act(() => recordPlacementReport({ agentId: "a1", kind: "sandbox" }))
    renderBadge()
    expect(screen.getByTestId("sandbox-placement-sandboxed")).toHaveTextContent(
      en.placement.sandboxedUntiered
    )
  })

  it("explains a Host fallback in the person's language", async () => {
    act(() =>
      recordPlacementReport({
        agentId: "a1",
        kind: "fallback",
        code: "sandbox_fallback_daemon_unreachable",
      })
    )
    renderBadge()

    expect(screen.getByTestId("sandbox-placement-fallback")).toHaveTextContent(
      en.placement.fallback
    )
    expect(await tooltipText("sandbox-placement-fallback")).toContain(
      pe.outcome.hostFallback.daemonUnreachable
    )
  })

  it("names a fallback code this build has no sentence for", async () => {
    act(() =>
      recordPlacementReport({ agentId: "a1", kind: "fallback", code: "sandbox_fallback_future" })
    )
    renderBadge()
    expect(await tooltipText("sandbox-placement-fallback")).toContain("sandbox_fallback_future")
  })

  // The Host's answer wins: the brain asked, the Host decided.
  it("prefers the Host's answer to the brain's request", () => {
    act(() => {
      recordRunEnvironmentOutcome("a1", {
        kind: "placed",
        placement: { kind: "container", spec: {} as never, isolationMandatory: false },
        notices: [],
      })
      recordPlacementReport({
        agentId: "a1",
        kind: "fallback",
        code: "sandbox_fallback_pool_disabled",
      })
    })
    renderBadge()
    expect(screen.getByTestId("sandbox-placement-fallback")).toBeInTheDocument()
    expect(screen.queryByTestId("sandbox-placement-pending")).not.toBeInTheDocument()
  })

  it("says a sandbox was requested while the Host has not answered", () => {
    act(() =>
      recordRunEnvironmentOutcome("a1", {
        kind: "placed",
        placement: { kind: "container", spec: {} as never, isolationMandatory: false },
        notices: [],
      })
    )
    renderBadge()
    expect(screen.getByTestId("sandbox-placement-pending")).toHaveTextContent(en.placement.pending)
  })

  it("shows a refused environment as a refusal with its reason", async () => {
    act(() =>
      recordRunEnvironmentOutcome("a1", {
        kind: "refused",
        code: "local_container_unavailable",
        notices: [],
      })
    )
    renderBadge()
    expect(screen.getByTestId("sandbox-placement-refused")).toHaveTextContent(en.placement.refused)
    expect(await tooltipText("sandbox-placement-refused")).toContain(
      pe.outcome.refused.localContainerUnavailable
    )
  })

  it("shows the brain's own fallback before the Host reports", () => {
    act(() =>
      recordRunEnvironmentOutcome("a1", {
        kind: "fallback",
        code: "sandbox_fallback_catalog_unreadable",
        notices: [],
      })
    )
    renderBadge()
    expect(screen.getByTestId("sandbox-placement-fallback")).toBeInTheDocument()
  })

  it("marks a placement kind this build does not recognize", () => {
    act(() => recordPlacementReport({ agentId: "a1", kind: "unknown" }))
    renderBadge()
    expect(screen.getByTestId("sandbox-placement-unknown")).toHaveTextContent(en.placement.unknown)
  })

  it("only shows its own agent", () => {
    act(() => recordPlacementReport({ agentId: "a2", kind: "sandbox", tier: "vm" }))
    const { container } = renderBadge("a1")
    expect(container).toBeEmptyDOMElement()
  })
})
