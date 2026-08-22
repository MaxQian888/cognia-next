/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  UnsandboxedConsentDialog,
  type UnsandboxedLaunchSubject,
} from "./unsandboxed-consent-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const subject: UnsandboxedLaunchSubject = {
  agentName: "Codex",
  runtimeId: "codex-acp",
  executablePath: "C:\\Users\\dev\\AppData\\npm\\npx.cmd",
  runtimeVersion: "1.2.3",
  commandLine: 'npx -y "@zed-industries/codex-acp"',
}

function setup(overrides: Partial<React.ComponentProps<typeof UnsandboxedConsentDialog>> = {}) {
  const onConfirm = jest.fn()
  const onOpenChange = jest.fn()
  render(
    <UnsandboxedConsentDialog
      open
      onOpenChange={onOpenChange}
      subject={subject}
      onConfirm={onConfirm}
      {...overrides}
    />
  )
  return { onConfirm, onOpenChange, user: userEvent.setup() }
}

describe("UnsandboxedConsentDialog", () => {
  it("shows exactly what would run", () => {
    setup()
    // Consent to "run Codex unsandboxed" is meaningless without the binary.
    expect(screen.getByTestId("unsandboxed-executable-path")).toHaveTextContent(
      "C:\\Users\\dev\\AppData\\npm\\npx.cmd"
    )
    expect(screen.getByTestId("unsandboxed-version")).toHaveTextContent("1.2.3")
    expect(screen.getByTestId("unsandboxed-command")).toHaveTextContent("@zed-industries/codex-acp")
  })

  it("says the version could not be determined rather than showing nothing", () => {
    setup({ subject: { ...subject, runtimeVersion: undefined } })
    expect(screen.getByTestId("unsandboxed-version")).toHaveTextContent("versionUnknown")
  })

  it("states the risk and the fact that consent breaks on change", () => {
    setup()
    expect(screen.getByText("risk")).toBeInTheDocument()
    expect(screen.getByText("invalidation")).toBeInTheDocument()
  })

  it("keeps confirm disabled until the disclosure is acknowledged", async () => {
    const { user, onConfirm } = setup()
    const confirm = screen.getByRole("button", { name: "confirm" })
    expect(confirm).toBeDisabled()

    await user.click(screen.getByRole("checkbox"))

    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("offers no way to skip the disclosure next time", () => {
    setup()
    // A "don't show again" here would turn a per-launch decision into a
    // standing one, which is exactly what the per-agent binding prevents.
    expect(screen.queryByText(/don't show again/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
  })

  it("closes without confirming on cancel", async () => {
    const { user, onConfirm, onOpenChange } = setup()
    await user.click(screen.getByRole("button", { name: "cancel" }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes after a successful confirm", async () => {
    const { user, onOpenChange } = setup()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "confirm" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("stays open and re-enables confirm when granting fails", async () => {
    const onConfirm = jest.fn().mockRejectedValue(new Error("policy revised"))
    const onOpenChange = jest.fn()
    render(
      <UnsandboxedConsentDialog
        open
        onOpenChange={onOpenChange}
        subject={subject}
        onConfirm={onConfirm}
      />
    )
    const user = userEvent.setup()

    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "confirm" }))

    await waitFor(() => expect(screen.getByRole("button", { name: "confirm" })).toBeEnabled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
