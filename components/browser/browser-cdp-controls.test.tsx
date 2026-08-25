import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const grantMock = jest.fn()
const revokeMock = jest.fn()
const executeMock = jest.fn()
jest.mock("@/lib/browser/cdp-client", () => ({
  grantCdpAccess: (...args: unknown[]) => grantMock(...args),
  revokeCdpAccess: (...args: unknown[]) => revokeMock(...args),
  executeCdpCommand: (...args: unknown[]) => executeMock(...args),
}))
const auditMock = jest.fn()
jest.mock("@/lib/db/browser-cdp", () => ({
  listCdpAuditEvents: (...args: unknown[]) => auditMock(...args),
}))

import { BrowserCdpControls } from "./browser-cdp-controls"

beforeEach(() => {
  auditMock.mockReset().mockResolvedValue([])
  grantMock.mockReset().mockResolvedValue({
    id: "grant-1",
    sessionId: "session-1",
    browserSessionId: "browser-1",
    origin: "http://localhost:3000",
    capabilities: ["dom"],
    grantedAt: 1,
    expiresAt: Date.now() + 60_000,
  })
  revokeMock.mockReset().mockResolvedValue(true)
  executeMock.mockReset().mockResolvedValue({
    method: "DOM.getDocument",
    value: { nodeId: 1, nodeName: "HTML", baseURL: "http://localhost:3000/" },
  })
})

it("grants, uses, and revokes session-scoped local CDP access", async () => {
  render(
    <BrowserCdpControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000/app?token=hidden"
    />
  )
  fireEvent.click(screen.getByText("Developer mode"))
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }))
  await waitFor(() =>
    expect(grantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        browserSessionId: "browser-1",
        capabilities: ["dom"],
      })
    )
  )
  fireEvent.click(screen.getByRole("button", { name: "Inspect document" }))
  await waitFor(() =>
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionTarget: "local", method: "DOM.getDocument" }),
      {}
    )
  )
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }))
  await waitFor(() => expect(revokeMock).toHaveBeenCalledWith("grant-1"))
})

it("shows what the bridge actually returned, not a fixed success string", async () => {
  render(
    <BrowserCdpControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000/app"
    />
  )
  fireEvent.click(screen.getByText("Developer mode"))
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }))
  await screen.findByRole("button", { name: "Inspect document" })
  fireEvent.click(screen.getByRole("button", { name: "Inspect document" }))

  const result = await screen.findByTestId("browser-cdp-result")
  expect(result).toHaveTextContent('"nodeName": "HTML"')
  expect(result).toHaveTextContent("Result of DOM.getDocument")
})

it("evaluates an expression when the grant carries the runtime capability", async () => {
  grantMock.mockResolvedValue({
    id: "grant-1",
    sessionId: "session-1",
    browserSessionId: "browser-1",
    origin: "http://localhost:3000",
    capabilities: ["dom", "runtime"],
    grantedAt: 1,
    expiresAt: Date.now() + 60_000,
  })
  executeMock.mockResolvedValue({ method: "Runtime.evaluate", value: "Home" })
  render(
    <BrowserCdpControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000/app"
    />
  )
  fireEvent.click(screen.getByText("Developer mode"))
  // The capability toggles are Radix checkboxes inside plain labels, so they
  // carry no accessible name; CAPABILITIES order is [dom, runtime].
  fireEvent.click(screen.getAllByRole("checkbox")[1]!)
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }))

  const field = await screen.findByLabelText("Expression")
  fireEvent.change(field, { target: { value: "document.title" } })
  fireEvent.click(screen.getByRole("button", { name: "Evaluate" }))

  await waitFor(() =>
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "runtime", method: "Runtime.evaluate" }),
      { expression: "document.title" }
    )
  )
  expect(await screen.findByTestId("browser-cdp-result")).toHaveTextContent("Home")
})

it("hides the expression field when the grant has no runtime capability", async () => {
  render(
    <BrowserCdpControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000/app"
    />
  )
  fireEvent.click(screen.getByText("Developer mode"))
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }))
  await screen.findByRole("button", { name: "Inspect document" })
  expect(screen.queryByLabelText("Expression")).toBeNull()
})

// Console, network and performance used to be offered as grantable
// capabilities with no method behind any of them. Console and network output
// live in the DevTools drawer instead.
it("only offers the capabilities the bridge can actually serve", () => {
  render(
    <BrowserCdpControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000/app"
    />
  )
  fireEvent.click(screen.getByText("Developer mode"))
  expect(screen.getByText("DOM")).toBeInTheDocument()
  expect(screen.getByText("Runtime")).toBeInTheDocument()
  for (const retired of ["Console", "Network", "Performance"]) {
    expect(screen.queryByText(retired)).toBeNull()
  }
})
