/** @jest-environment jsdom */
const recoverInterruptedOperations = jest.fn(async () => 1)
jest.mock("@/lib/sites/cloudflare/service", () => ({
  CloudflareSitesService: jest.fn(function (this: Record<string, unknown>) {
    this.recoverInterruptedOperations = recoverInterruptedOperations
  }),
}))
jest.mock("@/lib/db/sites", () => ({ listSiteProjects: jest.fn(async () => []) }))
const installSiteNotifications = jest.fn(() => jest.fn())
jest.mock("@/lib/sites/notify", () => ({
  installSiteNotifications: (...args: unknown[]) => installSiteNotifications(...args),
}))

import * as db from "@/lib/db/sites"
import { bootSites, recoverAllInterruptedSiteOperations } from "./boot"

function site(id: string, owner: string, lifecycle = "active") {
  return { id, lifecycle, authoringPolicy: { ownerAccountId: owner } }
}

beforeEach(() => jest.clearAllMocks())

describe("recoverAllInterruptedSiteOperations", () => {
  it("sweeps every Site the actor owns, not just one", async () => {
    // The console's own effect recovered the selected Site only, so a crash
    // mid-upload left that operation wedged until somebody opened /sites and
    // clicked that exact Site.
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([
      site("a", "me"),
      site("b", "me"),
      site("c", "me"),
    ])
    await expect(recoverAllInterruptedSiteOperations("me")).resolves.toBe(3)
    expect(recoverInterruptedOperations).toHaveBeenCalledTimes(3)
  })

  it("skips Sites the actor does not own — recovery asserts manage", async () => {
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([site("a", "me"), site("b", "someone")])
    await recoverAllInterruptedSiteOperations("me")
    expect(recoverInterruptedOperations).toHaveBeenCalledTimes(1)
    expect(recoverInterruptedOperations).toHaveBeenCalledWith("a")
  })

  it("skips a deleted Site", async () => {
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([site("a", "me", "deleted")])
    await recoverAllInterruptedSiteOperations("me")
    expect(recoverInterruptedOperations).not.toHaveBeenCalled()
  })

  it("does not build a service at all when there is nothing to sweep", async () => {
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([])
    await expect(recoverAllInterruptedSiteOperations("me")).resolves.toBe(0)
  })

  it("keeps sweeping after one Site throws", async () => {
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([site("a", "me"), site("b", "me")])
    recoverInterruptedOperations.mockRejectedValueOnce(new Error("unreachable"))
    await expect(recoverAllInterruptedSiteOperations("me")).resolves.toBe(1)
    expect(recoverInterruptedOperations).toHaveBeenCalledTimes(2)
  })
})

describe("bootSites", () => {
  it("installs the watcher and returns its disposer", async () => {
    const dispose = jest.fn()
    installSiteNotifications.mockReturnValue(dispose)
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([])
    const teardown = await bootSites({ actorAccountId: "me" })
    expect(installSiteNotifications).toHaveBeenCalled()
    teardown()
    expect(dispose).toHaveBeenCalled()
  })

  it("installs the watcher before sweeping, so a terminated operation is reported", async () => {
    const order: string[] = []
    installSiteNotifications.mockImplementation(() => {
      order.push("watch")
      return jest.fn()
    })
    ;(db.listSiteProjects as jest.Mock).mockImplementation(async () => {
      order.push("sweep")
      return []
    })
    await bootSites({ actorAccountId: "me" })
    expect(order).toEqual(["watch", "sweep"])
  })

  it("still returns a working teardown when the sweep fails", async () => {
    const dispose = jest.fn()
    installSiteNotifications.mockReturnValue(dispose)
    ;(db.listSiteProjects as jest.Mock).mockRejectedValue(new Error("db closed"))
    const teardown = await bootSites({ actorAccountId: "me" })
    teardown()
    expect(dispose).toHaveBeenCalled()
  })
})
