/** @jest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import messages from "@/i18n/messages/en.json"
import type { DshDoctorReport } from "@/lib/ai/agent/external/dsh-runtime-install"

const useDshRuntime = jest.fn()
jest.mock("@/hooks/agent/use-dsh-runtime", () => ({
  useDshRuntime: (...args: unknown[]) => useDshRuntime(...args),
}))

import { DeepSeekHarnessCard } from "./deepseek-harness-card"

const HEALTHY: DshDoctorReport = { healthy: true, findings: [] }

function state(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    report: HEALTHY,
    busy: false,
    error: undefined,
    installed: true,
    refresh: jest.fn(),
    install: jest.fn(),
    remove: jest.fn(),
    ...overrides,
  }
}

function renderCard(props: { profileId?: "cognia-sdk-readonly" | "cognia-sdk-workspace" } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DeepSeekHarnessCard {...props} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  useDshRuntime.mockReset()
  useDshRuntime.mockReturnValue(state())
})

describe("DeepSeekHarnessCard", () => {
  it("renders a dashed placeholder in hosts that cannot manage a runtime", () => {
    useDshRuntime.mockReturnValue(state({ supported: false }))
    renderCard()
    expect(screen.queryByTestId("deepseek-harness-card")).not.toBeInTheDocument()
  })

  it("marks the integration experimental", () => {
    // Upstream is a developer preview promising breaking changes.
    renderCard()
    expect(
      screen.getByText(messages.externalAgent.settings.deepseekHarness.experimentalBadge)
    ).toBeInTheDocument()
  })

  it("shows a healthy installed runtime", () => {
    renderCard()
    expect(screen.getByTestId("dsh-status")).toHaveTextContent(
      messages.externalAgent.settings.deepseekHarness.healthy
    )
  })

  it("offers Install when nothing is installed", () => {
    useDshRuntime.mockReturnValue(state({ installed: false, report: undefined }))
    renderCard()
    expect(screen.getByTestId("dsh-install")).toHaveTextContent(
      messages.externalAgent.settings.deepseekHarness.install
    )
    expect(screen.queryByTestId("dsh-remove")).not.toBeInTheDocument()
  })

  it("offers Reinstall and Remove once installed", () => {
    renderCard()
    expect(screen.getByTestId("dsh-install")).toHaveTextContent(
      messages.externalAgent.settings.deepseekHarness.reinstall
    )
    expect(screen.getByTestId("dsh-remove")).toBeInTheDocument()
  })

  it("requires a second click to remove", () => {
    // Removing breaks every agent using the runtime, so it must not be a single
    // stray click.
    const remove = jest.fn()
    useDshRuntime.mockReturnValue(state({ remove }))
    renderCard()
    fireEvent.click(screen.getByTestId("dsh-remove"))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("dsh-remove-confirm"))
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("renders each doctor finding as localized prose", () => {
    useDshRuntime.mockReturnValue(
      state({
        report: {
          healthy: false,
          findings: [
            { code: "composition-digest-mismatch", severity: "error", detail: "raw detail" },
            { code: "stray-patch-layer", severity: "error", detail: "/rt/home/cordis.patch.yml" },
          ],
        },
      })
    )
    renderCard()
    const findings = screen.getByTestId("dsh-findings")
    expect(findings).toHaveTextContent(
      messages.externalAgent.settings.deepseekHarness.findings.compositionDigestMismatch
    )
    expect(findings).toHaveTextContent(
      messages.externalAgent.settings.deepseekHarness.findings.strayPatchLayer
    )
    // The raw path is a log detail, not user-facing prose.
    expect(findings).not.toHaveTextContent("raw detail")
  })

  it("states that this transport cannot ask for approval or cancel one turn", () => {
    // Both are surprises if discovered mid-run, so they are stated up front.
    renderCard()
    const dsh = messages.externalAgent.settings.deepseekHarness
    expect(screen.getByText(dsh.approvalNotice)).toBeInTheDocument()
    expect(screen.getByText(dsh.cancelNotice)).toBeInTheDocument()
  })

  it("reports the read-only profile's capabilities honestly", () => {
    renderCard({ profileId: "cognia-sdk-readonly" })
    const dsh = messages.externalAgent.settings.deepseekHarness
    const rows = screen.getByTestId("dsh-capabilities")
    // SDK transport: rich observation, no interactive control.
    expect(rows).toHaveTextContent(dsh.capabilityToolEvents)
    expect(rows).toHaveTextContent(dsh.capabilitySupported)
    expect(rows).toHaveTextContent(dsh.capabilityUnsupported)
  })

  it("surfaces a lifecycle error as an alert", () => {
    useDshRuntime.mockReturnValue(state({ error: "npm install failed" }))
    renderCard()
    expect(screen.getByTestId("dsh-error")).toHaveTextContent("npm install failed")
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("disables the actions while a lifecycle call is in flight", () => {
    useDshRuntime.mockReturnValue(state({ busy: true }))
    renderCard()
    expect(screen.getByTestId("dsh-install")).toBeDisabled()
    expect(screen.getByTestId("dsh-refresh")).toBeDisabled()
  })

  it("triggers install and refresh", async () => {
    const install = jest.fn()
    const refresh = jest.fn()
    useDshRuntime.mockReturnValue(state({ install, refresh, installed: false }))
    renderCard()
    fireEvent.click(screen.getByTestId("dsh-install"))
    fireEvent.click(screen.getByTestId("dsh-refresh"))
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("passes the requested profile to the hook", () => {
    renderCard({ profileId: "cognia-sdk-workspace" })
    expect(useDshRuntime).toHaveBeenCalledWith("cognia-sdk-workspace")
  })

  it("defaults to the read-only profile", () => {
    // Read-only is the only profile whose authority cannot be escalated at
    // runtime on this transport.
    renderCard()
    expect(useDshRuntime).toHaveBeenCalledWith("cognia-sdk-readonly")
  })
})
