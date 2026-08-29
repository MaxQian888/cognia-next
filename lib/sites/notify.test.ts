/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  DEFAULT_SITE_NOTIFY_TEXT,
  __resetSiteNotificationsForTesting,
  installSiteNotificationCommands,
  installSiteNotifications,
  siteHref,
  siteOperationNotification,
} from "./notify"
import { dispatchNotificationCommand } from "@/lib/notifications/action-registry"
import type { SiteOperationRow } from "@/types/sites"

const SITE = { id: "site_1", name: "Docs" }

function operation(overrides: Partial<SiteOperationRow> = {}): SiteOperationRow {
  return {
    id: "op_1",
    siteId: "site_1",
    type: "deploy",
    executionTargetKey: "local",
    idempotencyKey: "k",
    inputDigest: "d",
    status: "succeeded",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe("siteOperationNotification", () => {
  it("carries the production URL on a successful deploy — the thing being waited for", () => {
    const input = siteOperationNotification(SITE, operation(), {
      productionUrl: "https://docs.example.com",
    })
    expect(input).toMatchObject({
      level: "success",
      title: "Docs is live",
      body: "https://docs.example.com",
      href: "/sites?site=site_1&tab=publish",
    })
  })

  it.each([
    ["build", "Docs failed to build"],
    ["upload", "Docs failed to upload"],
    ["deploy", "Docs failed to deploy"],
  ] as const)("names what failed for %s", (type, title) => {
    const input = siteOperationNotification(
      SITE,
      operation({ type, status: "failed", errorMessage: "exit 1" })
    )
    expect(input).toMatchObject({ level: "error", title, body: "exit 1" })
  })

  it("notifies for every failure, not a chosen few", () => {
    // A failed `domain` or `access` leaves the Site subtly wrong; an allowlist
    // here is how silent failures get born.
    for (const type of ["domain", "access", "environment", "provision"] as const) {
      expect(siteOperationNotification(SITE, operation({ type, status: "failed" }))?.level).toBe(
        "error"
      )
    }
  })

  it("flags an uncertain provider outcome, which only a human can resolve", () => {
    const input = siteOperationNotification(
      SITE,
      operation({ status: "waiting-reconcile", errorMessage: undefined })
    )
    expect(input).toMatchObject({ level: "warning", href: "/sites?site=site_1&tab=operations" })
    expect(input?.body).toContain("could not confirm")
  })

  it.each(["takedown", "restore", "purge"] as const)(
    "notifies for %s, which changes whether the Site is on the internet",
    (type) => {
      expect(siteOperationNotification(SITE, operation({ type }))).not.toBeNull()
    }
  )

  it.each(["provision", "upload", "environment", "access", "domain", "reconcile"] as const)(
    "stays quiet for an intermediate success: %s",
    (type) => {
      // Steps of a publish the console already renders as a progressive strip.
      expect(siteOperationNotification(SITE, operation({ type }))).toBeNull()
    }
  )

  it.each(["queued", "running", "cancelled"] as const)("stays quiet for %s", (status) => {
    expect(siteOperationNotification(SITE, operation({ status }))).toBeNull()
  })

  it("dedupes per operation, so two deploys are two rows", () => {
    // Keying by Site+kind would fold consecutive deploys into one and hide the
    // second, which for a deploy history is exactly backwards.
    const first = siteOperationNotification(SITE, operation({ id: "op_1" }))
    const second = siteOperationNotification(SITE, operation({ id: "op_2" }))
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey)
    expect(first?.groupKey).toBe(second?.groupKey)
  })

  it("uses the injected translator when one is given", () => {
    const input = siteOperationNotification(SITE, operation(), {}, (key) => `t:${key}`)
    expect(input?.title).toBe("t:notify.deploySucceeded.title")
  })

  it("has an English fallback for every key it asks for", () => {
    for (const key of Object.keys(DEFAULT_SITE_NOTIFY_TEXT)) {
      expect(DEFAULT_SITE_NOTIFY_TEXT[key]).not.toBe("")
    }
  })
})

describe("siteHref", () => {
  it("matches the query the route accepts", () => {
    expect(siteHref("site_1")).toBe("/sites?site=site_1")
    expect(siteHref("site_1", "operations")).toBe("/sites?site=site_1&tab=operations")
  })
})

describe("installSiteNotifications", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetSiteNotificationsForTesting()
  })

  it("notifies for an operation that lands after boot, once", async () => {
    const notify = jest.fn(async () => "n1")
    const dispose = installSiteNotifications({ since: 0, notify: notify as never })
    try {
      const db = getDb()
      await db.siteProjects.add({
        ...SITE,
        projectId: "p",
        sourceRoot: "/r",
        sourceSubpath: "",
        executionTarget: { kind: "local" },
        executionTargetKey: "local",
        provider: "cloudflare",
        providerConfig: { accountId: "a", workerName: "w" },
        authoringPolicy: { ownerAccountId: "o", editorAccountIds: [], deployerAccountIds: [] },
        visitorPolicy: { mode: "private" },
        lifecycle: "active",
        createdAt: 1,
        updatedAt: 1,
      } as never)
      await db.siteOperations.add(operation({ updatedAt: Date.now() }) as never)

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify.mock.calls[0][0]).toMatchObject({ source: "site", title: "Docs is live" })
    } finally {
      dispose()
    }
  })

  it("returns the existing disposer instead of installing twice", () => {
    const first = installSiteNotifications({ since: 0 })
    const second = installSiteNotifications({ since: 0 })
    expect(second).toBe(first)
    first()
  })
})

describe("installSiteNotificationCommands", () => {
  it("navigates to the Site the notification names", async () => {
    const navigate = jest.fn()
    const dispose = installSiteNotificationCommands({ navigate })
    try {
      await dispatchNotificationCommand({
        command: "site.open",
        args: { siteId: "site_1", tab: "operations" },
      } as never)
      expect(navigate).toHaveBeenCalledWith("/sites?site=site_1&tab=operations")
    } finally {
      dispose()
    }
  })

  it("ignores a record with no Site id rather than navigating nowhere", async () => {
    const navigate = jest.fn()
    const dispose = installSiteNotificationCommands({ navigate })
    try {
      await dispatchNotificationCommand({ command: "site.open", args: {} } as never)
      expect(navigate).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})
