import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  gatewaySetupDone,
  GatewaySetupSteps,
  type GatewaySetupStepsProps,
  isGatewaySetupComplete,
} from "./overview-setup-steps"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

function setup(over: Partial<GatewaySetupStepsProps> = {}) {
  const props: GatewaySetupStepsProps = {
    hasToken: false,
    running: false,
    callsTotal: 0,
    accountLocked: false,
    starting: false,
    onCreateKey: jest.fn(),
    onStart: jest.fn(),
    onShowConnect: jest.fn(),
    ...over,
  }
  render(<GatewaySetupSteps {...props} />)
  return props
}

describe("gatewaySetupDone / isGatewaySetupComplete", () => {
  it("derives each step from live status", () => {
    expect(gatewaySetupDone({ hasToken: true, running: false, callsTotal: 0 })).toEqual({
      key: true,
      start: false,
      connect: false,
    })
    expect(gatewaySetupDone({ hasToken: true, running: true, callsTotal: 3 })).toEqual({
      key: true,
      start: true,
      connect: true,
    })
  })

  it("is complete only once a request has been served by a running, keyed gateway", () => {
    expect(isGatewaySetupComplete({ hasToken: true, running: true, callsTotal: 0 })).toBe(false)
    // A stopped gateway is not set up, however many requests it served before.
    expect(isGatewaySetupComplete({ hasToken: true, running: false, callsTotal: 9 })).toBe(false)
    expect(isGatewaySetupComplete({ hasToken: true, running: true, callsTotal: 1 })).toBe(true)
  })
})

describe("GatewaySetupSteps", () => {
  it("marks the first unfinished step as current and counts progress", () => {
    setup({ hasToken: true })

    expect(screen.getByTestId("gateway-setup-step-key")).toHaveAttribute("data-state", "done")
    expect(screen.getByTestId("gateway-setup-step-start")).toHaveAttribute("aria-current", "step")
    expect(screen.getByTestId("gateway-setup-step-connect")).toHaveAttribute(
      "data-state",
      "pending"
    )
    expect(screen.getByText("progress:1,3")).toBeInTheDocument()
  })

  it("drops the action from a finished step", () => {
    setup({ hasToken: true })
    expect(screen.queryByTestId("gateway-setup-action-key")).not.toBeInTheDocument()
    expect(screen.getByTestId("gateway-setup-action-start")).toBeEnabled()
  })

  it("routes each step to its action", async () => {
    const user = userEvent.setup()
    const props = setup({ hasToken: true })

    await user.click(screen.getByTestId("gateway-setup-action-start"))
    await user.click(screen.getByTestId("gateway-setup-action-connect"))

    expect(props.onStart).toHaveBeenCalledTimes(1)
    expect(props.onShowConnect).toHaveBeenCalledTimes(1)
  })

  it("sends a keyless user to create a key and explains why start is locked", async () => {
    const user = userEvent.setup()
    const props = setup()

    await user.click(screen.getByTestId("gateway-setup-action-key"))

    expect(props.onCreateKey).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("gateway-setup-action-start")).toBeDisabled()
    expect(screen.getByTestId("gateway-setup-note-start")).toHaveTextContent("stepStartBlocked")
  })

  it("locks key creation while the local account is locked, and says so", () => {
    setup({ accountLocked: true })

    expect(screen.getByTestId("gateway-setup-action-key")).toBeDisabled()
    expect(screen.getByTestId("gateway-setup-note-key")).toHaveTextContent("stepKeyLocked")
  })

  it("locks the start action while a start is already in flight", () => {
    setup({ hasToken: true, starting: true })
    expect(screen.getByTestId("gateway-setup-action-start")).toBeDisabled()
  })
})
