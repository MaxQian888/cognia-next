jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    listApps: jest.fn(),
    getAppState: jest.fn(),
    queryElements: jest.fn(),
    expandElement: jest.fn(),
    performAction: jest.fn(),
    zoom: jest.fn(),
  },
}))

import { desktop } from "@/lib/automation/client"
import { isTauri } from "@/lib/tauri"
import type { ActionRequest, AppLocator } from "@/lib/automation/types"
import { __testing__, computerUse } from "./computer-use"

const mockedIsTauri = isTauri as jest.Mock
const mockedDesktop = desktop as jest.Mocked<typeof desktop>
const locator: AppLocator = {
  kind: "bundleId",
  bundleId: "com.apple.TextEdit",
}

beforeEach(() => {
  jest.clearAllMocks()
  __testing__.resetProxyClient()
})

describe("computerUse canonical renderer adapter", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("reads a screenshot-bound app revision with an authenticated turn key", async () => {
    mockedDesktop.getAppState.mockResolvedValueOnce({ revision: 3 } as never)
    const result = await computerUse({
      operation: "getAppState",
      sessionId: "app-session",
      turnKey: "message-1",
      locator,
    })

    expect(result).toEqual({ ok: true, result: { revision: 3 } })
    expect(mockedDesktop.getAppState).toHaveBeenCalledWith("app-session", locator, undefined, {
      surface: "mcp",
      turnKey: "message-1",
    })
  })

  it("forwards a canonical action request without translation", async () => {
    const request = {
      turnToken: "token",
      target: {
        kind: "pixel",
        target: {
          sessionId: "app-session",
          lineageId: "lineage",
          revision: 3,
          point: { x: 10, y: 20 },
          screenshotWidth: 100,
          screenshotHeight: 80,
        },
      },
      action: { kind: "click" },
      strategy: "pixel",
    } satisfies ActionRequest
    mockedDesktop.performAction.mockResolvedValueOnce({ status: "unknown" } as never)

    await computerUse({
      operation: "performAction",
      turnKey: "message-1",
      request,
    })

    expect(mockedDesktop.performAction).toHaveBeenCalledWith(request, {
      surface: "mcp",
      turnKey: "message-1",
    })
  })

  it("crops a region of the revision the caller already read", async () => {
    mockedDesktop.zoom.mockResolvedValueOnce({ revision: 3 } as never)
    const region = { x: 100, y: 200, width: 320, height: 240 }
    const result = await computerUse({
      operation: "zoom",
      sessionId: "app-session",
      lineageId: "lineage",
      revision: 3,
      region,
    })

    expect(result).toEqual({ ok: true, result: { revision: 3 } })
    // A zoom re-reads pixels the caller was already shown, so it carries no
    // turn key: there is no mutation to bind and no token to burn.
    expect(mockedDesktop.zoom).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "app-session", lineageId: "lineage", revision: 3 }),
      region,
      { surface: "mcp", turnKey: undefined }
    )
  })

  it("fails closed when a mutation has no authenticated turn key", async () => {
    const result = await computerUse({
      operation: "performAction",
      turnKey: "",
      request: {} as ActionRequest,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/turnKey/)
    expect(mockedDesktop.performAction).not.toHaveBeenCalled()
  })
})

it("routes non-desktop calls to the Node proxy boundary", async () => {
  mockedIsTauri.mockReturnValue(false)
  const previous = process.env.COGNIA_AUTOMATION_PROXY
  delete process.env.COGNIA_AUTOMATION_PROXY
  try {
    await expect(computerUse({ operation: "listApps" })).resolves.toMatchObject({ ok: false })
    expect(mockedDesktop.listApps).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.COGNIA_AUTOMATION_PROXY
    else process.env.COGNIA_AUTOMATION_PROXY = previous
  }
})
