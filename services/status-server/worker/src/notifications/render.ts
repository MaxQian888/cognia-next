/**
 * Email rendering. Runs once, when an outbox row is created: the subject,
 * plain-text and HTML bodies are stored on the row and never rebuilt, so a
 * retry sends exactly the same message even if the incident text changed
 * since (a later change is a later event with its own row).
 *
 * Mail is rendered in the subscriber's locale with English as the fallback
 * for missing operator text. Every dynamic value is HTML-escaped; operator
 * text is plain text and never interpreted as markup. Times are UTC and
 * also given in ISO-8601 so a mail client can localise them.
 */

import type {
  ComponentId,
  IncidentImpact,
  IncidentState,
  StatusLocale,
} from "../../../../../lib/status/contract"
import { pickLocalized } from "../../../../../lib/status/derive"
import { COMPONENT_LABELS } from "../incidents/templates"
import type { IncidentEventPayload, MaintenanceEventPayload } from "./events"

export interface RenderedMail {
  subject: string
  text: string
  html: string
}

export interface MailLinks {
  /** Public page (or incident deep link) for details. */
  detailUrl: string
  /** Fragment-token links; GET on them never changes consent. */
  manageUrl: string | null
  unsubscribeUrl: string | null
}

const BRAND: Record<StatusLocale, string> = { en: "Cognia Status", "zh-CN": "Cognia 状态" }

const STATE_LABELS: Record<IncidentState, Record<StatusLocale, string>> = {
  investigating: { en: "Investigating", "zh-CN": "调查中" },
  identified: { en: "Identified", "zh-CN": "已确定原因" },
  monitoring: { en: "Monitoring", "zh-CN": "观察中" },
  resolved: { en: "Resolved", "zh-CN": "已解决" },
}

const IMPACT_LABELS: Record<IncidentImpact, Record<StatusLocale, string>> = {
  degraded: { en: "Degraded performance", "zh-CN": "性能下降" },
  partial_outage: { en: "Partial outage", "zh-CN": "部分中断" },
  major_outage: { en: "Major outage", "zh-CN": "重大中断" },
}

const MAINTENANCE_PHASES: Record<
  MaintenanceEventPayload["phase"] | "completed" | "cancelled",
  Record<StatusLocale, string>
> = {
  scheduled: { en: "Maintenance scheduled", "zh-CN": "已计划维护" },
  changed: { en: "Maintenance changed", "zh-CN": "维护计划已变更" },
  started: { en: "Maintenance started", "zh-CN": "维护已开始" },
  ended: { en: "Maintenance ended", "zh-CN": "维护已结束" },
  completed: { en: "Maintenance completed", "zh-CN": "维护已完成" },
  cancelled: { en: "Maintenance cancelled", "zh-CN": "维护已取消" },
}

const LABELS = {
  components: { en: "Affected components", "zh-CN": "受影响组件" },
  status: { en: "Status", "zh-CN": "状态" },
  impact: { en: "Impact", "zh-CN": "影响" },
  window: { en: "Window", "zh-CN": "时间窗口" },
  actualEnd: { en: "Actual end", "zh-CN": "实际结束" },
  details: { en: "Details", "zh-CN": "详情" },
  manage: { en: "Manage preferences", "zh-CN": "管理订阅偏好" },
  unsubscribe: { en: "Unsubscribe", "zh-CN": "退订" },
  footer: {
    en: "You receive this because you subscribed to Cognia status notifications.",
    "zh-CN": "您收到此邮件是因为您订阅了 Cognia 状态通知。",
  },
} satisfies Record<string, Record<StatusLocale, string>>

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** `2026-10-02 10:00 UTC (2026-10-02T10:00:00.000Z)`. */
export function formatUtc(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC (${iso})`
}

function componentList(ids: readonly ComponentId[], locale: StatusLocale): string {
  const sep = locale === "zh-CN" ? "、" : ", "
  return ids.map((id) => COMPONENT_LABELS[id][locale] ?? COMPONENT_LABELS[id].en).join(sep)
}

interface Section {
  heading: string
  rows: Array<[label: string, value: string]>
  body: string | null
}

/** One layout for every mail: heading, facts, body text, links, footer. */
function compose(
  locale: StatusLocale,
  subject: string,
  section: Section,
  links: Array<{ label: string; url: string }>,
  footer: string | null
): RenderedMail {
  const textLines = [section.heading, ""]
  for (const [label, value] of section.rows) textLines.push(`${label}: ${value}`)
  if (section.body) textLines.push("", section.body)
  if (links.length > 0) textLines.push("")
  for (const link of links) textLines.push(`${link.label}: ${link.url}`)
  if (footer) textLines.push("", footer)

  const rowsHtml = section.rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`
    )
    .join("")
  const bodyHtml = section.body
    ? `<p style="white-space:pre-wrap">${escapeHtml(section.body)}</p>`
    : ""
  const linksHtml = links
    .map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`)
    .join(" &middot; ")
  const html = [
    `<!doctype html><html lang="${locale === "zh-CN" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>`,
    `<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.5;color:#111">`,
    `<h2 style="margin:0 0 12px">${escapeHtml(section.heading)}</h2>`,
    rowsHtml
      ? `<table style="border-collapse:collapse;margin-bottom:12px">${rowsHtml}</table>`
      : "",
    bodyHtml,
    linksHtml ? `<p>${linksHtml}</p>` : "",
    footer ? `<p style="color:#777;font-size:12px">${escapeHtml(footer)}</p>` : "",
    `</body></html>`,
  ].join("")
  return { subject, text: textLines.join("\n"), html }
}

function footerLinks(
  locale: StatusLocale,
  links: MailLinks
): Array<{ label: string; url: string }> {
  const out = [{ label: LABELS.details[locale], url: links.detailUrl }]
  if (links.manageUrl) out.push({ label: LABELS.manage[locale], url: links.manageUrl })
  if (links.unsubscribeUrl)
    out.push({ label: LABELS.unsubscribe[locale], url: links.unsubscribeUrl })
  return out
}

export function renderIncidentMail(
  payload: IncidentEventPayload,
  locale: StatusLocale,
  links: MailLinks
): RenderedMail {
  const title = pickLocalized(payload.title, locale)
  const state = STATE_LABELS[payload.state][locale]
  const subject = `[${BRAND[locale]}] ${state}: ${title}`
  return compose(
    locale,
    subject,
    {
      heading: title,
      rows: [
        [LABELS.status[locale], state],
        [LABELS.impact[locale], IMPACT_LABELS[payload.impact][locale]],
        [LABELS.components[locale], componentList(payload.componentIds, locale)],
        [locale === "zh-CN" ? "时间" : "Time", formatUtc(payload.atMs)],
      ],
      body: pickLocalized(payload.message, locale),
    },
    footerLinks(locale, links),
    LABELS.footer[locale]
  )
}

export function renderMaintenanceMail(
  payload: MaintenanceEventPayload,
  locale: StatusLocale,
  links: MailLinks
): RenderedMail {
  const title = pickLocalized(payload.title, locale)
  const phaseKey = payload.phase === "ended" && payload.endKind ? payload.endKind : payload.phase
  const phase = MAINTENANCE_PHASES[phaseKey][locale]
  const rows: Array<[string, string]> = [
    [LABELS.status[locale], phase],
    [LABELS.components[locale], componentList(payload.componentIds, locale)],
    [LABELS.window[locale], `${formatUtc(payload.startsAtMs)} – ${formatUtc(payload.endsAtMs)}`],
  ]
  if (payload.actualEndAtMs !== null)
    rows.push([LABELS.actualEnd[locale], formatUtc(payload.actualEndAtMs)])
  const description = pickLocalized(payload.description, locale)
  const note = payload.message ? pickLocalized(payload.message, locale) : null
  return compose(
    locale,
    `[${BRAND[locale]}] ${phase}: ${title}`,
    { heading: title, rows, body: note ? `${note}\n\n${description}` : description },
    footerLinks(locale, links),
    LABELS.footer[locale]
  )
}

export function renderConfirmationMail(locale: StatusLocale, confirmUrl: string): RenderedMail {
  if (locale === "zh-CN") {
    return compose(
      locale,
      `[${BRAND[locale]}] 请确认您的订阅`,
      {
        heading: "确认订阅 Cognia 状态通知",
        rows: [],
        body: "请打开下面的链接并点击确认按钮，以开始接收 Cognia 服务状态通知。链接 24 小时内有效。如果这不是您本人的操作，请忽略此邮件，您不会收到任何通知。",
      },
      [{ label: "确认订阅", url: confirmUrl }],
      null
    )
  }
  return compose(
    locale,
    `[${BRAND[locale]}] Confirm your subscription`,
    {
      heading: "Confirm your Cognia status subscription",
      rows: [],
      body: "Open the link below and press the confirm button to start receiving Cognia service status notifications. The link is valid for 24 hours. If you did not ask for this, ignore this email and you will receive nothing further.",
    },
    [{ label: "Confirm subscription", url: confirmUrl }],
    null
  )
}

export function renderWelcomeMail(
  locale: StatusLocale,
  links: MailLinks,
  purpose: "welcome" | "manage_link"
): RenderedMail {
  const zh = locale === "zh-CN"
  const subject =
    purpose === "welcome"
      ? zh
        ? `[${BRAND[locale]}] 订阅已确认`
        : `[${BRAND[locale]}] Subscription confirmed`
      : zh
        ? `[${BRAND[locale]}] 管理您的订阅`
        : `[${BRAND[locale]}] Manage your subscription`
  const body =
    purpose === "welcome"
      ? zh
        ? "您的订阅已确认。发生事件或计划维护时，我们会通知您。您可以随时通过下面的链接修改偏好或退订。"
        : "Your subscription is confirmed. We will email you about incidents and scheduled maintenance. Use the links below to change your preferences or unsubscribe at any time."
      : zh
        ? "有人请求为此地址订阅 Cognia 状态通知，而该地址已经订阅。您可以通过下面的链接管理偏好或退订。如果这不是您本人的操作，无需处理。"
        : "Someone asked to subscribe this address to Cognia status notifications, and it is already subscribed. Use the links below to manage your preferences or unsubscribe. If this was not you, no action is needed."
  return compose(
    locale,
    subject,
    { heading: subject.replace(/^\[[^\]]+\]\s*/, ""), rows: [], body },
    footerLinks(locale, links),
    LABELS.footer[locale]
  )
}
