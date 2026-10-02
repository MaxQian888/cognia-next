import { describe, expect, it } from "vitest"

import {
  escapeHtml,
  formatUtc,
  renderConfirmationMail,
  renderIncidentMail,
  renderMaintenanceMail,
} from "./render"

const T = Date.UTC(2026, 9, 2, 10, 0, 0)
const links = {
  detailUrl: "https://status.test/status/?incident=inc_1",
  manageUrl: "https://status.test/status/#action=manage&token=t",
  unsubscribeUrl: "https://status.test/status/#action=unsubscribe&token=t",
}

describe("mail rendering", () => {
  it("escapes operator text in HTML and keeps a plain-text part", () => {
    const mail = renderIncidentMail(
      {
        type: "incident",
        phase: "opened",
        incidentId: "inc_1",
        updateId: "upd_1",
        title: { en: "A & B <x>" },
        message: { en: `"quoted" <img src=x onerror=alert(1)>` },
        state: "investigating",
        impact: "major_outage",
        componentIds: ["relayData", "signalingAuth"],
        atMs: T,
      },
      "en",
      links
    )
    expect(mail.subject).toBe("[Cognia Status] Investigating: A & B <x>")
    expect(mail.html).toContain("A &amp; B &lt;x&gt;")
    expect(mail.html).not.toContain("<img")
    expect(mail.text).toContain(`"quoted" <img src=x onerror=alert(1)>`)
    expect(mail.text).toContain("Relay data channel, Signaling authentication")
    expect(mail.text).toContain("2026-10-02 10:00 UTC (2026-10-02T10:00:00.000Z)")
    expect(mail.text).toContain(links.unsubscribeUrl)
  })

  it("falls back to English for missing zh-CN text", () => {
    const mail = renderMaintenanceMail(
      {
        type: "maintenance",
        phase: "ended",
        endKind: "completed",
        maintenanceId: "mnt_1",
        title: { en: "Upgrade" },
        description: { en: "Rolling restart", "zh-CN": "滚动重启" },
        message: null,
        componentIds: ["relayData"],
        startsAtMs: T,
        endsAtMs: T + 3_600_000,
        actualEndAtMs: T + 1_800_000,
        revision: 3,
        atMs: T + 1_800_000,
      },
      "zh-CN",
      links
    )
    expect(mail.subject).toBe("[Cognia 状态] 维护已完成: Upgrade")
    expect(mail.text).toContain("滚动重启")
    expect(mail.text).toContain("实际结束")
  })

  it("renders the confirmation without management links", () => {
    const mail = renderConfirmationMail(
      "en",
      "https://status.test/status/#action=confirm&token=abc"
    )
    expect(mail.text).toContain("#action=confirm&token=abc")
    expect(mail.text).not.toContain("unsubscribe")
  })

  it("helpers escape and format deterministically", () => {
    expect(escapeHtml(`<'&">`)).toBe("&lt;&#39;&amp;&quot;&gt;")
    expect(formatUtc(T)).toBe("2026-10-02 10:00 UTC (2026-10-02T10:00:00.000Z)")
  })
})
