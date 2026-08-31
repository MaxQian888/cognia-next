/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { RECOVERY_ORDER, type RecoveryStateV1 } from "@cognia/logging"
import messages from "@/i18n/messages/en.json"

import { SAFE_MODE_SUBSYSTEMS, SafeModeShell } from "./safe-mode-shell"

function state(overrides: Partial<RecoveryStateV1> = {}): RecoveryStateV1 {
  return {
    schemaVersion: 1,
    buildId: "build-2026-08-01-01",
    mode: "safe",
    unhealthyStarts: [1, 2],
    checkpoints: RECOVERY_ORDER.map((subsystem) => ({ subsystem, status: "pending" as const })),
    rendererReload: {},
    childRestarts: {},
    disabledSubsystems: [],
    rendererAlive: false,
    audit: [],
    ...overrides,
  }
}

function renderShell(props: Partial<React.ComponentProps<typeof SafeModeShell>> = {}) {
  const onRetry = props.onRetry ?? jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SafeModeShell
        state={props.state === undefined ? state() : props.state}
        probing={props.probing ?? false}
        onRetry={onRetry}
      />
    </NextIntlClientProvider>
  )
  return { onRetry }
}

describe("SafeModeShell", () => {
  it("explains why the app is in diagnostics mode", () => {
    renderShell()
    expect(screen.getByRole("heading", { name: messages.safeMode.title })).toBeInTheDocument()
    expect(screen.getByText(messages.safeMode.description)).toBeInTheDocument()
  })

  it("lists every recovery group in order", () => {
    renderShell()
    for (const subsystem of SAFE_MODE_SUBSYSTEMS) {
      const label =
        messages.safeMode.subsystem[subsystem as keyof typeof messages.safeMode.subsystem]
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(SAFE_MODE_SUBSYSTEMS).toEqual([...RECOVERY_ORDER])
  })

  it("names the suspected subsystem and its reason code", () => {
    renderShell({
      state: state({
        suspectSubsystem: "plugins",
        suspectReasonCode: "plugins.manifest_invalid",
      }),
    })
    expect(screen.getByText(messages.safeMode.suspect.title)).toBeInTheDocument()
    expect(screen.getByText("plugins.manifest_invalid")).toBeInTheDocument()
  })

  it("says so when no single subsystem was identified", () => {
    renderShell({
      state: state({ suspectReasonCode: "renderer.reload_budget_exhausted" }),
    })
    expect(screen.getByText(messages.safeMode.suspect.unknownSubsystem)).toBeInTheDocument()
  })

  it("hides the suspect card when nothing is suspected", () => {
    renderShell()
    expect(screen.queryByText(messages.safeMode.suspect.title)).not.toBeInTheDocument()
  })

  it("offers retry and keep-off only for a failed group", async () => {
    const user = userEvent.setup()
    const { onRetry } = renderShell({
      state: state({
        checkpoints: [
          { subsystem: "database", status: "passed" },
          { subsystem: "plugins", status: "failed", reasonCode: "plugins.manifest_invalid" },
          { subsystem: "sidecar", status: "skipped", reasonCode: "blocked_by.plugins" },
        ],
      }),
    })

    const retryButtons = screen.getAllByRole("button", { name: messages.safeMode.actions.retry })
    expect(retryButtons).toHaveLength(1)

    await user.click(retryButtons[0])
    expect(onRetry).toHaveBeenCalledWith("plugins", "retry")

    await user.click(screen.getByRole("button", { name: messages.safeMode.actions.keepDisabled }))
    expect(onRetry).toHaveBeenCalledWith("plugins", "keep-disabled")
  })

  it("offers retry — but not keep-off — for a group already kept off", () => {
    renderShell({
      state: state({
        disabledSubsystems: ["plugins"],
        checkpoints: [{ subsystem: "plugins", status: "skipped" }],
      }),
    })
    expect(screen.getByText(messages.safeMode.status.disabled)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: messages.safeMode.actions.retry })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: messages.safeMode.actions.keepDisabled })
    ).not.toBeInTheDocument()
  })

  it("disables the actions while probes are running", () => {
    renderShell({
      probing: true,
      state: state({ checkpoints: [{ subsystem: "plugins", status: "failed" }] }),
    })
    expect(screen.getByRole("button", { name: messages.safeMode.actions.retry })).toBeDisabled()
  })

  it("labels the running indicator for assistive technology", () => {
    renderShell({ probing: true })
    expect(screen.getByLabelText(messages.safeMode.checkpoints.running)).toBeInTheDocument()
  })

  it("links only to surfaces that are safe without the held-back subsystems", () => {
    renderShell()
    expect(screen.getByRole("link", { name: messages.safeMode.available.logs })).toHaveAttribute(
      "href",
      "/logs"
    )
    expect(screen.getByRole("link", { name: messages.safeMode.available.backup })).toHaveAttribute(
      "href",
      "/settings?section=data"
    )
    expect(screen.getByRole("link", { name: messages.safeMode.available.about })).toHaveAttribute(
      "href",
      "/settings?section=about"
    )
  })

  it("shows the build the failure belongs to", () => {
    renderShell()
    expect(screen.getByText(/build-2026-08-01-01/)).toBeInTheDocument()
  })

  it("renders without state rather than crashing the last screen the user has", () => {
    renderShell({ state: null })
    expect(screen.getByText(messages.safeMode.checkpoints.empty)).toBeInTheDocument()
    expect(screen.queryByText(/build-/)).not.toBeInTheDocument()
  })
})
