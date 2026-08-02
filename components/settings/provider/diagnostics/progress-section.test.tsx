/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { ProgressSection } from "./progress-section"
import type { ResolvedProviderDiagnosticTarget } from "@/lib/provider-diagnostics/service"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const target = (overrides: Partial<ResolvedProviderDiagnosticTarget> = {}) =>
  ({
    id: "t1",
    providerId: "openai",
    modelId: "gpt-5",
    credentialId: "primary",
    credentialFingerprint: "credential:openai:primary",
    endpoint: "https://api.openai.com/v1",
    capability: "text-generation",
    credentials: {},
    billable: true,
    ...overrides,
  }) as ResolvedProviderDiagnosticTarget

const defaults = {
  percent: 50,
  completedCount: 1,
  targetCount: 2,
  pendingTargets: [target()],
  onCancelAll: jest.fn(),
  onCancelTarget: jest.fn(),
}

describe("ProgressSection", () => {
  beforeEach(() => jest.clearAllMocks())

  it("announces progress politely so a screen reader follows the run", () => {
    const { container } = render(<ProgressSection {...defaults} />)
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument()
    expect(screen.getByText(/progress\.count.*"completed":1.*"total":2/)).toBeInTheDocument()
  })

  it("rounds the percentage in the progress bar label", () => {
    render(<ProgressSection {...defaults} percent={49.6} />)
    expect(screen.getByLabelText(/progress\.aria.*"percent":50/)).toBeInTheDocument()
  })

  it("lists each pending target with its model and endpoint", () => {
    render(<ProgressSection {...defaults} />)
    expect(screen.getByText("gpt-5 · https://api.openai.com/v1")).toBeInTheDocument()
  })

  it("labels a probe target, which carries no model", () => {
    render(
      <ProgressSection
        {...defaults}
        pendingTargets={[target({ modelId: undefined, capability: "probe" })]}
      />
    )
    expect(screen.getByText("composer.probe · https://api.openai.com/v1")).toBeInTheDocument()
  })

  it("cancels the whole job and a single target independently", () => {
    render(<ProgressSection {...defaults} />)
    fireEvent.click(screen.getByTestId("diagnostics-cancel-all"))
    expect(defaults.onCancelAll).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "progress.cancelTarget" }))
    expect(defaults.onCancelTarget).toHaveBeenCalledWith("t1")
  })

  it("disables both cancels for a paired client, which does not own the job", () => {
    render(<ProgressSection {...defaults} cancelDisabled />)
    expect(screen.getByTestId("diagnostics-cancel-all")).toBeDisabled()
    expect(screen.getByRole("button", { name: "progress.cancelTarget" })).toBeDisabled()
  })
})
