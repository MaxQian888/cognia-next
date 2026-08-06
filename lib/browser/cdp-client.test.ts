const cdpGrantMock = jest.fn()
const cdpRevokeMock = jest.fn()
const cdpExecuteMock = jest.fn()
jest.mock("./client", () => ({
  browserClient: {
    cdpGrant: (...args: unknown[]) => cdpGrantMock(...args),
    cdpRevoke: (...args: unknown[]) => cdpRevokeMock(...args),
    cdpExecute: (...args: unknown[]) => cdpExecuteMock(...args),
  },
}))
const authorizeMock = jest.fn()
jest.mock("./cdp-policy", () => ({
  authorizeCdpAccess: (...args: unknown[]) => authorizeMock(...args),
}))
const putGrantMock = jest.fn()
const appendAuditMock = jest.fn()
const revokeGrantMock = jest.fn()
jest.mock("@/lib/db/browser-cdp", () => ({
  normalizeCdpOrigin: (value: string) => new URL(value).origin,
  putCdpGrant: (...args: unknown[]) => putGrantMock(...args),
  appendCdpAuditEvent: (...args: unknown[]) => appendAuditMock(...args),
  revokeCdpGrant: (...args: unknown[]) => revokeGrantMock(...args),
}))

import { executeCdpCommand, grantCdpAccess, revokeCdpAccess } from "./cdp-client"

beforeEach(() => {
  cdpGrantMock.mockReset().mockResolvedValue(undefined)
  cdpRevokeMock.mockReset().mockResolvedValue(undefined)
  cdpExecuteMock.mockReset().mockResolvedValue({ method: "Runtime.evaluate", value: "Home" })
  authorizeMock.mockReset().mockResolvedValue({ allowed: true, reason: "allowed" })
  putGrantMock.mockReset().mockResolvedValue(undefined)
  appendAuditMock.mockReset().mockResolvedValue(undefined)
  revokeGrantMock.mockReset().mockResolvedValue(true)
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "audit-1" },
  })
})

it("registers the same session grant natively and in device-local Dexie", async () => {
  const grant = await grantCdpAccess({
    id: "grant-1",
    sessionId: "session-1",
    browserSessionId: "browser-1",
    pageUrl: "http://localhost:3000/private?token=secret",
    capabilities: ["runtime"],
    durationMs: 1000,
    now: 10,
  })
  expect(grant.origin).toBe("http://localhost:3000")
  expect(cdpGrantMock).toHaveBeenCalledWith(grant)
  expect(putGrantMock).toHaveBeenCalledWith(grant)
  expect(appendAuditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "granted" }))
})

it("executes only after renderer authorization and the native gate", async () => {
  const request = {
    grantId: "grant-1",
    sessionId: "session-1",
    browserSessionId: "browser-1",
    pageUrl: "http://localhost:3000",
    capability: "runtime" as const,
    method: "Runtime.evaluate",
    executionTarget: "local" as const,
  }
  await expect(executeCdpCommand(request, { expression: "document.title" })).resolves.toEqual({
    method: "Runtime.evaluate",
    value: "Home",
  })
  expect(cdpExecuteMock).toHaveBeenCalledWith({
    ...request,
    params: { expression: "document.title" },
  })
})

it("never calls native execution after a remote request is rejected", async () => {
  authorizeMock.mockResolvedValue({ allowed: false, reason: "local_target_required" })
  await expect(
    executeCdpCommand(
      {
        grantId: "grant-1",
        sessionId: "session-1",
        browserSessionId: "browser-1",
        pageUrl: "http://localhost:3000",
        capability: "dom",
        method: "DOM.getDocument",
        executionTarget: "remote",
      },
      {}
    )
  ).rejects.toThrow(/local_target_required/)
  expect(cdpExecuteMock).not.toHaveBeenCalled()
})

it("revokes native authority before updating durable metadata", async () => {
  await expect(revokeCdpAccess("grant-1", 20)).resolves.toBe(true)
  expect(cdpRevokeMock).toHaveBeenCalledWith("grant-1")
  expect(revokeGrantMock).toHaveBeenCalledWith("grant-1", 20, "audit-1")
})
