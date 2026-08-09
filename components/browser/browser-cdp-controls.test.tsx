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
  executeMock.mockReset().mockResolvedValue({ method: "DOM.getDocument", value: {} })
})

it("grants, uses, and revokes session-scoped local CDP access", async () => {
  render(
    <BrowserCdpControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000/app?token=hidden"
    />
  )
  fireEvent.click(screen.getByText("Developer mode (CDP)"))
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
