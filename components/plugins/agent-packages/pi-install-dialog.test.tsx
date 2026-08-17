/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import type { PiMutationPlan } from "@/lib/pi-packages/mutate"
import type { PiPackageScope, PiPackageSource } from "@/lib/pi-packages/types"
import messages from "@/i18n/messages/en.json"
import { PiInstallDialog } from "./pi-install-dialog"

const CLI_PLAN: PiMutationPlan = { strategy: "pi-cli", command: "pi install npm:pi-memory@0.4.2" }
const FALLBACK_PLAN: PiMutationPlan = {
  strategy: "settings-edit",
  degradedReason: "pi-unavailable",
}

interface Options {
  spec?: string
  scope?: PiPackageScope
  installed?: readonly PiPackageSource[]
  plan?: PiMutationPlan | null
  projectPath?: string | null
  busy?: boolean
}

function renderDialog(options: Options = {}) {
  const onConfirm = jest.fn()
  const onCancel = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PiInstallDialog
        request={{ spec: options.spec ?? "npm:pi-memory@0.4.2", scope: options.scope ?? "user" }}
        installed={options.installed ?? []}
        plan={options.plan ?? CLI_PLAN}
        projectPath={options.projectPath ?? "/repo/.pi/settings.json"}
        busy={options.busy ?? false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </NextIntlClientProvider>
  )
  return { onConfirm, onCancel }
}

describe("PiInstallDialog", () => {
  it("renders nothing without a request", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PiInstallDialog
          request={null}
          installed={[]}
          plan={null}
          projectPath={null}
          busy={false}
          onConfirm={jest.fn()}
          onCancel={jest.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByTestId("pi-install-dialog")).not.toBeInTheDocument()
  })

  /** The user must see the exact command before it runs, not a description. */
  it("shows the exact command Pi will be invoked with", () => {
    renderDialog()
    expect(screen.getByText("pi install npm:pi-memory@0.4.2")).toBeInTheDocument()
  })

  /**
   * The fallback records intent but downloads nothing. Presenting it as
   * equivalent to `pi install` would be the misleading part.
   */
  it("says the settings-edit fallback is weaker, not just different", () => {
    renderDialog({ plan: FALLBACK_PLAN })
    const notice = screen.getByTestId("pi-install-degraded")
    expect(notice).toHaveTextContent(/does not download anything/i)
    expect(screen.queryByText(/^pi install/)).not.toBeInTheDocument()
  })

  it("reports the budget this package adds", () => {
    renderDialog()
    expect(
      screen.getByText(/adds 1,400 always-on tokens and 7 always-visible tools/i)
    ).toBeInTheDocument()
  })

  it("says a zero-cost package adds nothing rather than showing zeroes", () => {
    renderDialog({ spec: "npm:@narumitw/pi-statusline@0.49.6" })
    expect(screen.getByText(/adds no always-visible surface/i)).toBeInTheDocument()
  })

  it("calls out a package that can start extra paid contexts", () => {
    renderDialog({ spec: "npm:@narumitw/pi-subagents@1.0.0" })
    expect(screen.getByText(/start extra paid model contexts/i)).toBeInTheDocument()
  })

  /** Reinstalling at a new pin must not double-count what is already paid for. */
  it("shows no delta for a package already installed at another pin", () => {
    renderDialog({ spec: "npm:pi-memory@0.4.2", installed: ["npm:pi-memory@0.1.0"] })
    expect(screen.getByText(/adds no always-visible surface/i)).toBeInTheDocument()
  })

  it("warns about an overlap with something already installed", () => {
    renderDialog({
      spec: "npm:@vtstech/pi-long-term-memory@1.3.5",
      installed: ["npm:pi-memory@0.4.2"],
    })
    const warning = screen.getByTestId("pi-install-overlap")
    expect(warning).toHaveTextContent(/overlaps something you already have/i)
    expect(warning).toHaveTextContent(/Memory/i)
  })

  it("stays quiet when there is no overlap", () => {
    renderDialog({ installed: ["npm:@narumitw/pi-statusline@0.49.6"] })
    expect(screen.queryByTestId("pi-install-overlap")).not.toBeInTheDocument()
  })

  it("warns when the review recommends against the package", () => {
    renderDialog({ spec: "npm:pi-finish-notification@1.0.4" })
    expect(screen.getByTestId("pi-install-avoid")).toBeInTheDocument()
  })

  /** Writing a repo file affects everyone who checks it out. */
  it("names the version-controlled file for a project-scope install", () => {
    renderDialog({ scope: "project" })
    expect(screen.getByTestId("pi-install-project-warning")).toHaveTextContent(
      "/repo/.pi/settings.json"
    )
  })

  it("shows no repo warning for a user-scope install", () => {
    renderDialog({ scope: "user" })
    expect(screen.queryByTestId("pi-install-project-warning")).not.toBeInTheDocument()
  })

  it("confirms and cancels through its callbacks", async () => {
    const { onConfirm, onCancel } = renderDialog()
    await userEvent.click(screen.getByTestId("pi-install-confirm"))
    expect(onConfirm).toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("locks both buttons while the mutation runs", () => {
    renderDialog({ busy: true })
    expect(screen.getByTestId("pi-install-confirm")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
  })
})
