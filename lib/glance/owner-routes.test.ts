import type { GlanceOwnerSurface } from "./registry"
import { GLANCE_MODULES } from "./registry"
import {
  glanceMobileOwnerHref,
  glanceOwnerHref,
  schedulerHref,
  workflowRunsHref,
} from "./owner-routes"

const OWNERS: readonly GlanceOwnerSurface[] = [
  "fleet",
  "workflows",
  "usage",
  "subscription",
  "scheduler",
  "notifications",
  "connectivity",
  "conversations",
  "pet",
  "tray-actions",
]

describe("glanceOwnerHref", () => {
  it.each(OWNERS.map((o) => [o]))("maps %s to an absolute route", (owner) => {
    const href = glanceOwnerHref(owner)
    expect(href.startsWith("/")).toBe(true)
    expect(href.length).toBeGreaterThan(1)
  })

  it("gives every module's owner a route", () => {
    for (const def of Object.values(GLANCE_MODULES)) {
      expect(glanceOwnerHref(def.owner)).toMatch(/^\//)
    }
  })

  it("routes usage to the subscription settings usage tab", () => {
    const href = glanceOwnerHref("usage")
    expect(href).toContain("section=subscription")
    expect(href).toContain("subTab=usage")
  })

  it("routes subscription to the subscription section without a sub tab", () => {
    const href = glanceOwnerHref("subscription")
    expect(href).toContain("section=subscription")
    expect(href).not.toContain("subTab")
  })

  it("routes settings-owned surfaces to their sections", () => {
    expect(glanceOwnerHref("notifications")).toContain("section=notifications")
    expect(glanceOwnerHref("connectivity")).toContain("section=connectivity")
    expect(glanceOwnerHref("tray-actions")).toContain("section=desktop")
  })

  it("routes page-owned surfaces to their pages", () => {
    expect(glanceOwnerHref("conversations")).toBe("/conversations")
    expect(glanceOwnerHref("pet")).toBe("/pet")
    expect(glanceOwnerHref("fleet")).toBe("/agent-runs")
  })

  it("routes the scheduler, encoding an item id", () => {
    expect(glanceOwnerHref("scheduler")).toBe("/scheduler")
    expect(glanceOwnerHref("scheduler", "app:abc")).toBe("/scheduler?item=app%3Aabc")
  })

  it("ignores an item id for owners that do not take one", () => {
    expect(glanceOwnerHref("pet", "x")).toBe("/pet")
    expect(glanceOwnerHref("usage", "x")).toBe(glanceOwnerHref("usage"))
  })
})

describe("schedulerHref", () => {
  it("returns the bare page without an id (or with an empty one)", () => {
    expect(schedulerHref()).toBe("/scheduler")
    expect(schedulerHref("")).toBe("/scheduler")
  })

  it("percent-encodes reserved characters", () => {
    expect(schedulerHref("plugin:a b&c")).toBe("/scheduler?item=plugin%3Aa%20b%26c")
  })
})

describe("workflowRunsHref", () => {
  it("selects one workflow's runs, encoding the id", () => {
    expect(workflowRunsHref("wf 1/x")).toBe("/workflows/runs?id=wf%201%2Fx")
  })

  it("is the runs list without an id", () => {
    expect(workflowRunsHref()).toBe("/workflows/runs")
  })

  it("is where the desktop's workflows owner lands", () => {
    expect(glanceOwnerHref("workflows", "wf-1")).toBe(workflowRunsHref("wf-1"))
  })
})

describe("glanceMobileOwnerHref", () => {
  it.each(OWNERS.filter((o) => o !== "tray-actions").map((o) => [o]))(
    "maps %s to an absolute phone route",
    (owner) => {
      expect(glanceMobileOwnerHref(owner)).toMatch(/^\/./)
    }
  )

  it("has no page for the quick module's owner, whose editor is a sheet on a phone", () => {
    expect(glanceMobileOwnerHref("tray-actions")).toBeNull()
  })

  it("sends Fleet to the phone's own Fleet page, not the desktop run history", () => {
    expect(glanceMobileOwnerHref("fleet")).toBe("/fleet")
  })

  it("keeps usage and quota under Me › Subscription", () => {
    expect(glanceMobileOwnerHref("usage")).toBe("/me/subscription?subTab=usage")
    expect(glanceMobileOwnerHref("subscription")).toBe("/me/subscription")
  })

  it("routes the rest to the phone's pages", () => {
    expect(glanceMobileOwnerHref("notifications")).toBe("/me/notifications")
    expect(glanceMobileOwnerHref("connectivity")).toBe("/devices")
    expect(glanceMobileOwnerHref("scheduler", "task:1")).toBe(schedulerHref("task:1"))
    expect(glanceMobileOwnerHref("workflows", "wf")).toBe(workflowRunsHref("wf"))
    expect(glanceMobileOwnerHref("pet")).toBe("/pet")
    expect(glanceMobileOwnerHref("conversations")).toBe("/conversations")
  })
})
