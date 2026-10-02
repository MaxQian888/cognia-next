import { describe, expect, it } from "vitest"

import type { IncidentEventPayload, MaintenanceEventPayload } from "./events"
import {
  escapeHtml,
  formatDuration,
  formatUtc,
  formatUtcWindow,
  incidentTone,
  MAIL_TONES,
  maintenanceTone,
  renderConfirmationMail,
  renderIncidentMail,
  renderMaintenanceMail,
  renderWelcomeMail,
  type RenderedMail,
} from "./render"

const T = Date.UTC(2026, 9, 2, 10, 0, 0)
const links = {
  detailUrl: "https://status.test/status/?incident=inc_1",
  manageUrl: "https://status.test/status/#action=manage&token=t",
  unsubscribeUrl: "https://status.test/status/#action=unsubscribe&token=t",
}

function incident(overrides: Partial<IncidentEventPayload> = {}): IncidentEventPayload {
  return {
    type: "incident",
    phase: "opened",
    incidentId: "inc_1",
    updateId: "upd_1",
    title: { en: "Relay connections failing", "zh-CN": "中继连接失败" },
    message: { en: "We are investigating.", "zh-CN": "我们正在调查。" },
    state: "investigating",
    impact: "major_outage",
    componentIds: ["relayData", "signalingAuth"],
    atMs: T,
    ...overrides,
  }
}

function maintenance(overrides: Partial<MaintenanceEventPayload> = {}): MaintenanceEventPayload {
  return {
    type: "maintenance",
    phase: "scheduled",
    endKind: null,
    maintenanceId: "mnt_1",
    title: { en: "Upgrade" },
    description: { en: "Rolling restart", "zh-CN": "滚动重启" },
    message: null,
    componentIds: ["relayData"],
    startsAtMs: T,
    endsAtMs: T + 3_600_000,
    actualEndAtMs: null,
    revision: 1,
    atMs: T,
    ...overrides,
  } as MaintenanceEventPayload
}

/** Every mail is self-contained, safe and below Gmail's ~102 KB clipping. */
function expectWellFormed(mail: RenderedMail) {
  expect(mail.html.startsWith("<!doctype html>")).toBe(true)
  expect(mail.html).toContain('<meta name="color-scheme" content="light dark">')
  expect(mail.html).not.toMatch(/<script|<img|<link\b|<iframe|javascript:/i)
  expect(mail.html).not.toMatch(/<[^>]+\ssrc=/i)
  for (const [, href] of mail.html.matchAll(/href="([^"]*)"/g)) {
    expect(href.startsWith("https://")).toBe(true)
  }
  expect(new TextEncoder().encode(mail.html).byteLength).toBeLessThan(100_000)
  // Template markup never leaks into the plain-text part (operator text may
  // legitimately contain angle brackets, so only template tags are checked).
  expect(mail.text).not.toMatch(/<(table|td|a|p|span|div)\b/i)
}

describe("mail rendering", () => {
  it("escapes operator text in HTML and keeps a plain-text part", () => {
    const mail = renderIncidentMail(
      incident({
        title: { en: "A & B <x>" },
        message: { en: `"quoted" <img src=x onerror=alert(1)>` },
      }),
      "en",
      links
    )
    expectWellFormed(mail)
    expect(mail.subject).toBe("[Cognia Status] Investigating: A & B <x>")
    expect(mail.html).toContain("A &amp; B &lt;x&gt;")
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(mail.text).toContain(`"quoted" <img src=x onerror=alert(1)>`)
    expect(mail.text).toContain("Relay data channel, Signaling authentication")
    expect(mail.text).toContain("Oct 2, 2026 · 10:00 UTC")
    expect(mail.text).toContain(links.unsubscribeUrl)
  })

  it("draws an incident in its impact colour and a resolution in green", () => {
    const open = renderIncidentMail(incident(), "en", links)
    expect(open.html).toContain(MAIL_TONES.major.accent)
    expect(open.html).toContain("&#9679;</span>&nbsp;Investigating</span>")
    expect(open.text).toContain("Impact: Major outage")
    expect(open.html).toContain("New incident")
    // Components render as chips, the update as a labelled quote block.
    expect(open.html.match(/class="cs-chip"/g)).toHaveLength(2)
    expect(open.html).toContain("Latest update")
    expect(open.html).toContain(`href="${escapeHtml(links.detailUrl)}"`)

    const resolved = renderIncidentMail(
      incident({ phase: "resolved", state: "resolved" }),
      "zh-CN",
      links
    )
    expectWellFormed(resolved)
    expect(resolved.html).toContain(MAIL_TONES.operational.accent)
    expect(resolved.html).not.toContain(MAIL_TONES.major.accent)
    expect(resolved.subject).toBe("[Cognia 状态] 已解决: 中继连接失败")
    expect(resolved.html).toContain("事件已解决")
    expect(resolved.text).toContain("2026年10月2日 10:00 UTC")
    expect(resolved.text).toContain("中继数据通道、信令认证")
  })

  it("maps every state to the status page's tones", () => {
    expect(incidentTone({ state: "investigating", impact: "degraded" })).toBe("degraded")
    expect(incidentTone({ state: "monitoring", impact: "partial_outage" })).toBe("partial")
    expect(incidentTone({ state: "identified", impact: "major_outage" })).toBe("major")
    expect(incidentTone({ state: "resolved", impact: "major_outage" })).toBe("operational")
    expect(maintenanceTone("scheduled")).toBe("maintenance")
    expect(maintenanceTone("started")).toBe("maintenance")
    expect(maintenanceTone("completed")).toBe("operational")
    expect(maintenanceTone("cancelled")).toBe("neutral")
  })

  it("falls back to English for missing zh-CN text and shows the window", () => {
    const mail = renderMaintenanceMail(
      maintenance({
        phase: "ended",
        endKind: "completed",
        actualEndAtMs: T + 1_800_000,
        revision: 3,
        atMs: T + 1_800_000,
      }),
      "zh-CN",
      links
    )
    expectWellFormed(mail)
    expect(mail.subject).toBe("[Cognia 状态] 维护已完成: Upgrade")
    expect(mail.text).toContain("滚动重启")
    expect(mail.text).toContain("实际结束")
    expect(mail.text).toContain("2026年10月2日 10:00–11:00 UTC (1 小时)")
    expect(mail.html).toContain(MAIL_TONES.operational.accent)

    const scheduled = renderMaintenanceMail(maintenance(), "en", links)
    expect(scheduled.html).toContain(MAIL_TONES.maintenance.accent)
    expect(scheduled.text).toContain("Oct 2, 2026 · 10:00–11:00 UTC (1 h)")
  })

  it("renders the confirmation as a button with a copyable link and no management links", () => {
    const url = "https://status.test/status/#action=confirm&token=abc"
    for (const locale of ["en", "zh-CN"] as const) {
      const mail = renderConfirmationMail(locale, url)
      expectWellFormed(mail)
      // Button and fallback both carry the link.
      expect(mail.html.match(new RegExp(`href="${escapeHtml(url)}"`, "g"))).toHaveLength(2)
      expect(mail.html).toContain('class="cs-btn"')
      expect(mail.text).toContain("#action=confirm&token=abc")
      expect(mail.text.toLowerCase()).not.toContain("unsubscribe")
      expect(mail.html).not.toContain("action=manage")
    }
    expect(renderConfirmationMail("zh-CN", url).html).toContain("确认订阅")
  })

  it("welcomes with the status page as the action and manage/unsubscribe in the footer", () => {
    const welcome = renderWelcomeMail("en", links, "welcome")
    expectWellFormed(welcome)
    expect(welcome.subject).toBe("[Cognia Status] Subscription confirmed")
    expect(welcome.html).toContain(MAIL_TONES.operational.accent)
    expect(welcome.html).toContain(`href="${escapeHtml(links.manageUrl)}"`)
    expect(welcome.html).toContain(`href="${escapeHtml(links.unsubscribeUrl)}"`)
    expect(welcome.text).toContain(`View current status: ${links.detailUrl}`)

    const manage = renderWelcomeMail("zh-CN", links, "manage_link")
    expectWellFormed(manage)
    expect(manage.subject).toBe("[Cognia 状态] 管理您的订阅")
    expect(manage.text).toContain(`管理订阅偏好: ${links.manageUrl}`)
    expect(
      manage.html.match(new RegExp(`href="${escapeHtml(links.manageUrl)}"`, "g"))
    ).toHaveLength(1)
  })

  it("puts a hidden inbox preview first", () => {
    const mail = renderIncidentMail(incident(), "en", links)
    const preview = mail.html.indexOf('style="display:none')
    expect(preview).toBeGreaterThan(0)
    expect(preview).toBeLessThan(mail.html.indexOf("<h1"))
    expect(mail.html).toContain("Investigating · Major outage — We are investigating.")
  })

  it("helpers escape and format deterministically", () => {
    expect(escapeHtml(`<'&">`)).toBe("&lt;&#39;&amp;&quot;&gt;")
    expect(formatUtc(T)).toBe("Oct 2, 2026 · 10:00 UTC")
    expect(formatUtc(T, "zh-CN")).toBe("2026年10月2日 10:00 UTC")
    expect(formatDuration(90 * 60_000, "en")).toBe("1 h 30 min")
    expect(formatDuration(26 * 3_600_000, "zh-CN")).toBe("1 天 2 小时")
    expect(formatDuration(0, "en")).toBeNull()
    expect(formatUtcWindow(T, T + 26 * 3_600_000, "en")).toBe(
      "Oct 2, 2026 · 10:00 UTC – Oct 3, 2026 · 12:00 UTC (1 d 2 h)"
    )
  })
})
