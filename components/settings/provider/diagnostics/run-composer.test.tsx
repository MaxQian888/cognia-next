/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { RunComposer, type RunComposerProps } from "./run-composer"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

// Radix Select needs layout APIs jsdom lacks; the composer's assertions are
// about which controls exist and what the parent is told, not the popper.
jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}))

const props: RunComposerProps = {
  mode: "quick",
  onModeChange: jest.fn(),
  capability: "probe",
  onCapabilityChange: jest.fn(),
  modelId: "gpt-5",
  onModelIdChange: jest.fn(),
  modelIds: ["gpt-5", "gpt-5-mini"],
  credentialId: "primary",
  onCredentialIdChange: jest.fn(),
  credentialPoolSize: 2,
  endpoint: "https://api.openai.com/v1",
  onEndpointChange: jest.fn(),
  endpointCandidates: [
    { id: "c1", providerId: "openai", url: "https://api.openai.com/v1", source: "current" },
  ],
  concurrency: 2,
  onConcurrencyChange: jest.fn(),
  timeoutMs: 30_000,
  onTimeoutMsChange: jest.fn(),
  remotePaidEnabled: false,
  onRemotePaidEnabledChange: jest.fn(),
  onReviewRun: jest.fn(),
  running: false,
  runDisabled: false,
}

describe("RunComposer", () => {
  beforeEach(() => jest.clearAllMocks())

  it("hides the model picker for a probe, which sends no prompt", () => {
    render(<RunComposer {...props} />)
    expect(screen.queryByText("composer.model")).not.toBeInTheDocument()
  })

  it("shows the model picker for a paid capability", () => {
    render(<RunComposer {...props} capability="text-generation" />)
    expect(screen.getByText("composer.model")).toBeInTheDocument()
  })

  it("offers one pooled credential entry per configured key, plus the primary", () => {
    render(<RunComposer {...props} />)
    expect(screen.getByText("composer.primaryCredential")).toBeInTheDocument()
    expect(screen.getByText(/composer\.poolCredential.*"index":1/)).toBeInTheDocument()
    expect(screen.getByText(/composer\.poolCredential.*"index":2/)).toBeInTheDocument()
  })

  it("previews the request count for the selected mode", () => {
    const { rerender } = render(<RunComposer {...props} />)
    expect(screen.getByText(/composer\.preview.*"requests":1/)).toBeInTheDocument()
    rerender(<RunComposer {...props} mode="precise" />)
    expect(screen.getByText(/composer\.preview.*"requests":4/)).toBeInTheDocument()
  })

  it("clamps concurrency into the supported range", () => {
    render(<RunComposer {...props} />)
    const input = screen.getByLabelText("composer.concurrency")
    fireEvent.change(input, { target: { value: "99" } })
    expect(props.onConcurrencyChange).toHaveBeenCalledWith(5)
    fireEvent.change(input, { target: { value: "0" } })
    expect(props.onConcurrencyChange).toHaveBeenCalledWith(1)
  })

  it("floors the timeout at one second so a run cannot be configured to always fail", () => {
    render(<RunComposer {...props} />)
    fireEvent.change(screen.getByLabelText("composer.timeout"), { target: { value: "10" } })
    expect(props.onTimeoutMsChange).toHaveBeenCalledWith(1_000)
  })

  it("proposes a run rather than starting one", () => {
    render(<RunComposer {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "composer.reviewRun" }))
    expect(props.onReviewRun).toHaveBeenCalledTimes(1)
  })

  it("refuses to queue a second run while one is in flight", () => {
    render(<RunComposer {...props} running />)
    expect(screen.getByRole("button", { name: "composer.reviewRun" })).toBeDisabled()
  })

  it("refuses to run an incomplete configuration", () => {
    render(<RunComposer {...props} runDisabled />)
    expect(screen.getByRole("button", { name: "composer.reviewRun" })).toBeDisabled()
  })
})
