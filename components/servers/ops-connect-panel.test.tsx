/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ServerOpsValue } from "./ops-context"
import { OpsConnectPanel } from "./ops-connect-panel"

const connect = jest.fn<Promise<boolean>, [Parameters<ServerOpsValue["connect"]>[0]]>()
let value: Partial<ServerOpsValue>

jest.mock("./ops-context", () => ({
  useServerOps: () => value,
}))

beforeEach(() => {
  connect.mockReset().mockResolvedValue(true)
  value = { connect, connecting: false, transport: "tauri" }
})

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  overrides: { url?: string; profile?: string; token?: string } = {}
) {
  await user.clear(screen.getByLabelText("Controller URL"))
  await user.type(
    screen.getByLabelText("Controller URL"),
    overrides.url ?? "https://ops.example.com"
  )
  await user.clear(screen.getByLabelText("Connection profile"))
  await user.type(screen.getByLabelText("Connection profile"), overrides.profile ?? "production")
  await user.type(screen.getByLabelText("OIDC access token"), overrides.token ?? "oidc-token")
  await user.click(screen.getByRole("button", { name: "Connect" }))
}

it("passes the trimmed connection details upward", async () => {
  const user = userEvent.setup()
  render(<OpsConnectPanel />)

  await fillAndSubmit(user, { url: "  https://ops.example.com  " })
  expect(connect).toHaveBeenCalledWith({
    controllerUrl: "https://ops.example.com",
    profileId: "production",
    accessToken: "oidc-token",
  })
})

it("blocks a plain-HTTP controller before a request is attempted", async () => {
  const user = userEvent.setup()
  render(<OpsConnectPanel />)

  // Plain HTTP to a routable host would put the bearer token on the wire in
  // clear text; the client rejects it too, but only after the user submits.
  await fillAndSubmit(user, { url: "http://ops.example.com" })
  expect(connect).not.toHaveBeenCalled()
  expect(
    screen.getByText("Use https://, or http:// only for a loopback controller.")
  ).toBeInTheDocument()
})

it("allows a loopback controller over HTTP for local development", async () => {
  const user = userEvent.setup()
  render(<OpsConnectPanel />)

  await fillAndSubmit(user, { url: "http://127.0.0.1:8080" })
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({ controllerUrl: "http://127.0.0.1:8080" })
  )
})

it("names the missing scheme rather than reporting a generic failure", async () => {
  const user = userEvent.setup()
  render(<OpsConnectPanel />)

  await fillAndSubmit(user, { url: "ops.example.com" })
  expect(connect).not.toHaveBeenCalled()
  expect(screen.getByText("Enter a full URL, including the scheme.")).toBeInTheDocument()
})

it("clears the token field after a rejected attempt", async () => {
  const user = userEvent.setup()
  connect.mockResolvedValue(false)
  render(<OpsConnectPanel />)

  await fillAndSubmit(user)
  // A rejected token is not worth keeping in a field the next attempt would
  // resubmit unchanged.
  expect(screen.getByLabelText("OIDC access token")).toHaveValue("")
})

it("warns about CORS only on the browser transport", () => {
  const { unmount } = render(<OpsConnectPanel />)
  expect(screen.queryByText("Browser transport")).not.toBeInTheDocument()
  unmount()

  value = { connect, connecting: false, transport: "browser" }
  render(<OpsConnectPanel />)
  expect(screen.getByText("Browser transport")).toBeInTheDocument()
})

it("disables the submit button while a connection is in flight", () => {
  value = { connect, connecting: true, transport: "tauri" }
  render(<OpsConnectPanel />)
  expect(screen.getByRole("button", { name: /Connecting/ })).toBeDisabled()
})
