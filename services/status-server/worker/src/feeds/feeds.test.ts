import { beforeEach, describe, expect, it } from "vitest"

import { T0, MINUTE, baseEnv, context, resetOwnerE } from "../admin/test-support"
import { planCreateIncident } from "../incidents/store"
import { planScheduleWindow } from "../maintenance/store"
import { FEED_ENTRY_LIMIT, escapeXml } from "./feed"
import { handleFeedRoutes } from "./index"

async function incident(
  atMs: number,
  title: { en: string; "zh-CN"?: string },
  message = "Investigating"
): Promise<string> {
  const plan = planCreateIncident(baseEnv.DB, {
    title,
    state: "investigating",
    impact: "partial_outage",
    componentIds: ["relayData"],
    source: "manual",
    fingerprint: null,
    pinned: true,
    manualOwner: "operator@cognia.test",
    predecessorId: null,
    update: {
      message: { en: message, "zh-CN": "调查中" },
      source: "manual",
      atMs,
      evidenceAtMs: null,
      correctionOf: null,
    },
  })
  await baseEnv.DB.batch(plan.statements)
  return plan.incidentId
}

async function fetchFeed(path: string, method = "GET"): Promise<Response | null> {
  const request = new Request(`https://status.test/api/status/v1${path}`, { method })
  return handleFeedRoutes(request, baseEnv, context(request, T0 + 60 * MINUTE))
}

describe("feeds", () => {
  beforeEach(async () => {
    await resetOwnerE()
  })

  it("only serves the two feed paths", async () => {
    expect(await fetchFeed("/feed.json")).toBeNull()
    expect((await fetchFeed("/feed.atom", "POST"))!.status).toBe(405)
  })

  it("serves escaped Atom with stable entry IDs, links and both languages", async () => {
    const id = await incident(
      T0,
      { en: "Relay <down> & out", "zh-CN": "中继中断" },
      "</content><script>alert(1)</script>"
    )
    const window = planScheduleWindow(baseEnv.DB, {
      title: { en: "Upgrade" },
      description: { en: "Rolling restart" },
      componentIds: ["relayData"],
      startsAtMs: T0 + 120 * MINUTE,
      endsAtMs: T0 + 180 * MINUTE,
      exclude: true,
      atMs: T0 + MINUTE,
    })
    await baseEnv.DB.batch(window.statements)

    const response = await fetchFeed("/feed.atom")
    expect(response!.status).toBe(200)
    expect(response!.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8")
    expect(response!.headers.get("access-control-allow-origin")).toBe("*")
    expect(response!.headers.get("cache-control")).toBe("public, max-age=60")
    const xml = await response!.text()
    expect(xml).toContain(`<id>tag:status.test,2026:incident:${id}</id>`)
    expect(xml).toContain(`<id>tag:status.test,2026:maintenance:${window.maintenanceId}</id>`)
    expect(xml).toContain(`href="https://status.test/status/?incident=${id}"`)
    expect(xml).toContain("Relay &lt;down&gt; &amp; out")
    expect(xml).not.toContain("<script>")
    expect(xml).not.toMatch(/<\/content><script>/)
    expect(xml).toContain("— 简体中文 —")
    // Newest update first.
    expect(xml.indexOf("Upgrade")).toBeLessThan(xml.indexOf("Relay &lt;down"))

    const again = await (await fetchFeed("/feed.atom"))!.text()
    expect(again).toBe(xml)
  })

  it("serves RSS whose guids change per revision", async () => {
    const id = await incident(T0, { en: "Outage" })
    const rss = await (await fetchFeed("/feed.rss"))!.text()
    expect(rss).toContain(`<guid isPermaLink="false">tag:status.test,2026:incident:${id}:r1</guid>`)
    expect(rss).toContain("<pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate>")
    const head = await fetchFeed("/feed.rss", "HEAD")
    expect(head!.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8")
    expect(await head!.text()).toBe("")
  })

  it("is bounded", async () => {
    for (let index = 0; index < FEED_ENTRY_LIMIT + 5; index += 1)
      await incident(T0 + index, { en: `I${index}` })
    const xml = await (await fetchFeed("/feed.atom"))!.text()
    expect(xml.match(/<entry>/g)).toHaveLength(FEED_ENTRY_LIMIT)
  })

  it("strips characters XML cannot carry", () => {
    expect(escapeXml("a\u0001b\u0000c'\"")).toBe("abc&apos;&quot;")
  })
})
