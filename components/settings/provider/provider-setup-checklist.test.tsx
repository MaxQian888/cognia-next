/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { ProviderSetupChecklist, nextActionKey } from "./provider-setup-checklist"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const checklist = {
  steps: [
    { id: "credential" as const, done: true },
    { id: "base_url" as const, done: true },
    { id: "default_model" as const, done: false, nextAction: "select_default_model" as const },
    { id: "verification" as const, done: false, nextAction: "verify_connection" as const },
  ],
  total: 4,
  completed: 2,
  isComplete: false,
  nextAction: "select_default_model" as const,
}

describe("ProviderSetupChecklist", () => {
  it("renders nothing once every step is complete", () => {
    const { container } = render(
      <ProviderSetupChecklist checklist={{ ...checklist, isComplete: true, completed: 4 }} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("lists every step with its done state and the progress counter", () => {
    render(<ProviderSetupChecklist checklist={checklist} />)
    expect(screen.getByTestId("provider-setup-progress")).toHaveTextContent(
      'readiness.progress:{"completed":2,"total":4}'
    )
    expect(screen.getByTestId("provider-setup-step-credential")).toHaveAttribute(
      "data-done",
      "true"
    )
    expect(screen.getByTestId("provider-setup-step-verification")).toHaveAttribute(
      "data-done",
      "false"
    )
    expect(screen.getByText("setupStepDefaultModel")).toBeInTheDocument()
  })

  it("names the next action and maps it to the readiness namespace", () => {
    render(<ProviderSetupChecklist checklist={checklist} />)
    expect(screen.getByText("readiness.nextAction_select_default_model")).toBeInTheDocument()
    expect(nextActionKey("add_api_key")).toBe("readiness.nextAction_add_api_key")
  })

  it("offers a verify button only when the next action is a connection test", () => {
    const onVerify = jest.fn()
    const { rerender } = render(
      <ProviderSetupChecklist checklist={checklist} onVerify={onVerify} />
    )
    expect(screen.queryByTestId("provider-setup-verify")).not.toBeInTheDocument()

    rerender(
      <ProviderSetupChecklist
        checklist={{ ...checklist, completed: 3, nextAction: "verify_connection" }}
        onVerify={onVerify}
      />
    )
    fireEvent.click(screen.getByTestId("provider-setup-verify"))
    expect(onVerify).toHaveBeenCalledTimes(1)
  })

  it("disables the verify button while a test runs", () => {
    render(
      <ProviderSetupChecklist
        checklist={{ ...checklist, nextAction: "verify_connection" }}
        onVerify={jest.fn()}
        isVerifying
      />
    )
    expect(screen.getByTestId("provider-setup-verify")).toBeDisabled()
  })

  it("adds the keyless hint for local engines", () => {
    render(<ProviderSetupChecklist checklist={checklist} isLocalEngine />)
    expect(screen.getByText("readiness.localReady")).toBeInTheDocument()
  })
})
