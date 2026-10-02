/**
 * Email rendering. Runs once, when an outbox row is created: the subject,
 * plain-text and HTML bodies are stored on the row and never rebuilt, so a
 * retry sends exactly the same message even if the incident text changed
 * since (a later change is a later event with its own row).
 *
 * Mail is rendered in the subscriber's locale with English as the fallback
 * for missing operator text. Every dynamic value is HTML-escaped; operator
 * text is plain text and never interpreted as markup. Times are UTC.
 *
 * The HTML follows the public status page's look (black brand mark, neutral
 * card, the page's status colours) within what mail clients render reliably:
 * table layout, inline styles, a bulletproof button, no images, no web fonts,
 * no scripts. A small `<style>` block only adds dark mode and narrow-screen
 * padding for clients that support it; every client gets a complete light
 * layout without it.
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

type Localized = Record<StatusLocale, string>

const BRAND: Localized = { en: "Cognia Status", "zh-CN": "Cognia 状态" }

const STATE_LABELS: Record<IncidentState, Localized> = {
  investigating: { en: "Investigating", "zh-CN": "调查中" },
  identified: { en: "Identified", "zh-CN": "已确定原因" },
  monitoring: { en: "Monitoring", "zh-CN": "观察中" },
  resolved: { en: "Resolved", "zh-CN": "已解决" },
}

const IMPACT_LABELS: Record<IncidentImpact, Localized> = {
  degraded: { en: "Degraded performance", "zh-CN": "性能下降" },
  partial_outage: { en: "Partial outage", "zh-CN": "部分中断" },
  major_outage: { en: "Major outage", "zh-CN": "重大中断" },
}

const INCIDENT_PHASES: Record<IncidentEventPayload["phase"], Localized> = {
  opened: { en: "New incident", "zh-CN": "新事件" },
  updated: { en: "Incident update", "zh-CN": "事件更新" },
  resolved: { en: "Incident resolved", "zh-CN": "事件已解决" },
}

type MaintenancePhaseKey = MaintenanceEventPayload["phase"] | "completed" | "cancelled"

const MAINTENANCE_PHASES: Record<MaintenancePhaseKey, Localized> = {
  scheduled: { en: "Maintenance scheduled", "zh-CN": "已计划维护" },
  changed: { en: "Maintenance changed", "zh-CN": "维护计划已变更" },
  started: { en: "Maintenance started", "zh-CN": "维护已开始" },
  ended: { en: "Maintenance ended", "zh-CN": "维护已结束" },
  completed: { en: "Maintenance completed", "zh-CN": "维护已完成" },
  cancelled: { en: "Maintenance cancelled", "zh-CN": "维护已取消" },
}

const LABELS = {
  system: { en: "System status", "zh-CN": "系统状态" },
  relay: { en: "Official hosted relay", "zh-CN": "官方托管中继" },
  components: { en: "Affected components", "zh-CN": "受影响组件" },
  impact: { en: "Impact", "zh-CN": "影响" },
  actualEnd: { en: "Actual end", "zh-CN": "实际结束" },
  update: { en: "Latest update", "zh-CN": "最新进展" },
  details: { en: "View on the status page", "zh-CN": "在状态页查看详情" },
  statusPage: { en: "Status page", "zh-CN": "状态页" },
  manage: { en: "Manage preferences", "zh-CN": "管理订阅偏好" },
  unsubscribe: { en: "Unsubscribe", "zh-CN": "退订" },
  footer: {
    en: "You receive this because you subscribed to Cognia status notifications.",
    "zh-CN": "您收到此邮件是因为您订阅了 Cognia 状态通知。",
  },
  utcNote: { en: "All times are UTC.", "zh-CN": "所有时间均为 UTC。" },
} satisfies Record<string, Localized>

// ---------------------------------------------------------------------------
// Tones: the status page's colours (Tailwind emerald/sky/amber/orange/rose).
// ---------------------------------------------------------------------------

export type MailTone = "operational" | "maintenance" | "degraded" | "partial" | "major" | "neutral"

interface ToneColors {
  /** Accent bar and pill dot. */
  accent: string
  /** Pill background. */
  soft: string
  /** Pill text. */
  text: string
}

export const MAIL_TONES: Record<MailTone, ToneColors> = {
  operational: { accent: "#10b981", soft: "#ecfdf5", text: "#047857" },
  maintenance: { accent: "#0ea5e9", soft: "#f0f9ff", text: "#0369a1" },
  degraded: { accent: "#f59e0b", soft: "#fffbeb", text: "#92400e" },
  partial: { accent: "#f97316", soft: "#fff7ed", text: "#9a3412" },
  major: { accent: "#e11d48", soft: "#fff1f2", text: "#be123c" },
  neutral: { accent: "#18181b", soft: "#f4f4f5", text: "#3f3f46" },
}

const IMPACT_TONES: Record<IncidentImpact, MailTone> = {
  degraded: "degraded",
  partial_outage: "partial",
  major_outage: "major",
}

export function incidentTone(payload: Pick<IncidentEventPayload, "state" | "impact">): MailTone {
  return payload.state === "resolved" ? "operational" : IMPACT_TONES[payload.impact]
}

export function maintenanceTone(phase: MaintenancePhaseKey): MailTone {
  if (phase === "completed" || phase === "ended") return "operational"
  if (phase === "cancelled") return "neutral"
  return "maintenance"
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function utcParts(ms: number) {
  const date = new Date(ms)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    clock: `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`,
  }
}

function formatUtcDate(ms: number, locale: StatusLocale): string {
  const { year, month, day } = utcParts(ms)
  return locale === "zh-CN" ? `${year}年${month + 1}月${day}日` : `${MONTHS[month]} ${day}, ${year}`
}

/** `Oct 2, 2026 · 10:00 UTC` / `2026年10月2日 10:00 UTC`. Hand-formatted, no ICU. */
export function formatUtc(ms: number, locale: StatusLocale = "en"): string {
  const sep = locale === "zh-CN" ? " " : " · "
  return `${formatUtcDate(ms, locale)}${sep}${utcParts(ms).clock} UTC`
}

/** `1 h 30 min` / `1 小时 30 分钟`; null for a non-positive span. */
export function formatDuration(ms: number, locale: StatusLocale): string | null {
  const minutes = Math.round(ms / 60_000)
  if (minutes <= 0) return null
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const parts: string[] = []
  if (locale === "zh-CN") {
    if (days) parts.push(`${days} 天`)
    if (hours) parts.push(`${hours} 小时`)
    if (mins) parts.push(`${mins} 分钟`)
  } else {
    if (days) parts.push(`${days} d`)
    if (hours) parts.push(`${hours} h`)
    if (mins) parts.push(`${mins} min`)
  }
  return parts.join(" ")
}

/** One-day windows share the date: `Oct 2, 2026 · 10:00–11:00 UTC (1 h)`. */
export function formatUtcWindow(startMs: number, endMs: number, locale: StatusLocale): string {
  const start = utcParts(startMs)
  const end = utcParts(endMs)
  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day
  const range = sameDay
    ? `${formatUtcDate(startMs, locale)}${locale === "zh-CN" ? " " : " · "}${start.clock}–${end.clock} UTC`
    : `${formatUtc(startMs, locale)} – ${formatUtc(endMs, locale)}`
  const duration = formatDuration(endMs - startMs, locale)
  return duration ? `${range} (${duration})` : range
}

function componentNames(ids: readonly ComponentId[], locale: StatusLocale): string[] {
  return ids.map((id) => COMPONENT_LABELS[id][locale] ?? COMPONENT_LABELS[id].en)
}

/** Inbox preview text: whitespace collapsed, at most ~140 characters. */
function preheaderText(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > 140 ? `${flat.slice(0, 139).trimEnd()}…` : flat
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type FactValue = { kind: "text"; value: string } | { kind: "chips"; values: string[] }

interface MailContent {
  locale: StatusLocale
  subject: string
  tone: MailTone
  /** Small label above the pill, e.g. "New incident". */
  eyebrow: string
  /** Pill text, e.g. "Investigating · Major outage". */
  pill: string
  title: string
  /** One line under the title. */
  lead: string | null
  facts: Array<[label: string, value: FactValue]>
  /** Operator or explanatory text, rendered in a quote block. */
  note: { label: string | null; body: string } | null
  /** Additional paragraphs (plain text). */
  paragraphs: string[]
  cta: { label: string; url: string } | null
  /** Show the CTA URL as copyable text (confirmation links). */
  ctaFallback: string | null
  footerLinks: Array<{ label: string; url: string }>
  footer: string | null
  showUtcNote: boolean
  preheader: string
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"

/**
 * Dark mode and small-screen tweaks for clients that honour `<style>`
 * (Apple Mail, iOS Mail, Outlook.com/apps, Gmail on some platforms). The
 * `!important` overrides inline light colours only inside the media query.
 */
const STYLE = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (max-width:600px){.cs-pad{padding:24px 20px!important}.cs-outer{padding:20px 8px!important}.cs-title{font-size:20px!important}}
@media (prefers-color-scheme:dark){
.cs-page{background:#09090b!important}
.cs-card{background:#18181b!important;border-color:#27272a!important}
.cs-title,.cs-strong{color:#fafafa!important}
.cs-muted{color:#a1a1aa!important}
.cs-rule{border-color:#27272a!important}
.cs-note{background:#202023!important;color:#e4e4e7!important}
.cs-chip{background:#27272a!important;color:#e4e4e7!important;border-color:#3f3f46!important}
.cs-mark{background:#fafafa!important;color:#09090b!important}
.cs-btn{background:#fafafa!important}
.cs-btn a{color:#09090b!important}
.cs-link{color:#e4e4e7!important}
}`

function factHtml(value: FactValue): string {
  if (value.kind === "text") {
    return `<span class="cs-strong" style="color:#18181b">${escapeHtml(value.value)}</span>`
  }
  return value.values
    .map(
      (chip) =>
        `<span class="cs-chip" style="display:inline-block;margin:0 6px 6px 0;padding:3px 10px;border:1px solid #e4e4e7;border-radius:999px;background:#fafafa;color:#27272a;font-size:13px;line-height:20px;white-space:nowrap">${escapeHtml(chip)}</span>`
    )
    .join("")
}

function factText(value: FactValue, locale: StatusLocale): string {
  return value.kind === "text" ? value.value : value.values.join(locale === "zh-CN" ? "、" : ", ")
}

function button(label: string, url: string): string {
  // Bulletproof button: the cell carries the colour, so clients that drop
  // padding on links (Outlook desktop) still show a solid button.
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:28px 0 0">`,
    `<tr><td class="cs-btn" bgcolor="#18181b" style="border-radius:10px;background:#18181b">`,
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(label)} &rarr;</a>`,
    `</td></tr></table>`,
  ].join("")
}

function renderHtml(content: MailContent): string {
  const tone = MAIL_TONES[content.tone]
  const lang = content.locale === "zh-CN" ? "zh-CN" : "en"
  const factsHtml = content.facts
    .map(
      ([label, value], index) =>
        `<tr><td class="cs-muted cs-rule" valign="top" style="padding:12px 16px 12px 0;${index === 0 ? "" : "border-top:1px solid #f4f4f5;"}width:136px;color:#71717a;font-size:13px;line-height:20px">${escapeHtml(label)}</td>` +
        `<td class="cs-rule" valign="top" style="padding:12px 0 ${value.kind === "chips" ? "6px" : "12px"};${index === 0 ? "" : "border-top:1px solid #f4f4f5;"}font-size:14px;line-height:20px">${factHtml(value)}</td></tr>`
    )
    .join("")
  const noteHtml = content.note
    ? [
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0">`,
        `<tr><td class="cs-note" style="padding:16px 18px;background:#fafafa;border-left:3px solid ${tone.accent};border-radius:0 10px 10px 0;color:#27272a">`,
        content.note.label
          ? `<div class="cs-muted" style="margin:0 0 6px;color:#71717a;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(content.note.label)}</div>`
          : "",
        `<div style="font-size:15px;line-height:24px;white-space:pre-wrap;word-break:break-word">${escapeHtml(content.note.body)}</div>`,
        `</td></tr></table>`,
      ].join("")
    : ""
  const paragraphsHtml = content.paragraphs
    .map(
      (paragraph) =>
        `<p class="cs-strong" style="margin:16px 0 0;color:#3f3f46;font-size:15px;line-height:24px">${escapeHtml(paragraph)}</p>`
    )
    .join("")
  const fallbackHtml = content.ctaFallback
    ? `<p class="cs-muted" style="margin:20px 0 0;color:#71717a;font-size:12px;line-height:18px">${escapeHtml(content.ctaFallback)}<br><a class="cs-link" href="${escapeHtml(content.cta?.url ?? "")}" style="color:#3f3f46;word-break:break-all">${escapeHtml(content.cta?.url ?? "")}</a></p>`
    : ""
  const footerLinksHtml = content.footerLinks
    .map(
      (link) =>
        `<a class="cs-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener" style="color:#52525b;text-decoration:underline">${escapeHtml(link.label)}</a>`
    )
    .join(`<span style="color:#d4d4d8">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`)

  return [
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">`,
    `<title>${escapeHtml(content.subject)}</title><style>${STYLE}</style></head>`,
    `<body class="cs-page" style="margin:0;padding:0;background:#f4f4f5;-webkit-text-size-adjust:100%">`,
    // Hidden preview text, padded so clients do not pull body text after it.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${escapeHtml(content.preheader)}${"&#8199;&#65279;&#847; ".repeat(24)}</div>`,
    `<table role="presentation" class="cs-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5">`,
    `<tr><td class="cs-outer" align="center" style="padding:36px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT}">`,
    // Brand row.
    `<tr><td style="padding:0 4px 18px">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td class="cs-mark" width="28" height="28" align="center" valign="middle" bgcolor="#18181b" style="width:28px;height:28px;border-radius:8px;background:#18181b;color:#ffffff;font-size:14px;font-weight:700;line-height:28px">C</td>`,
    `<td style="padding-left:10px;font-size:15px;line-height:20px"><span class="cs-strong" style="color:#09090b;font-weight:650">Cognia</span>`,
    `<span class="cs-muted" style="color:#71717a">&nbsp;&nbsp;${escapeHtml(LABELS.system[content.locale])}</span></td>`,
    `</tr></table></td></tr>`,
    // Card.
    `<tr><td class="cs-card" style="background:#ffffff;border:1px solid #e4e4e7;border-radius:16px;overflow:hidden">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    `<tr><td height="4" bgcolor="${tone.accent}" style="height:4px;line-height:4px;font-size:0;background:${tone.accent};border-radius:16px 16px 0 0">&nbsp;</td></tr>`,
    `<tr><td class="cs-pad" style="padding:32px 36px 36px">`,
    `<div class="cs-muted" style="margin:0 0 12px;color:#71717a;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase">${escapeHtml(content.eyebrow)}</div>`,
    `<span style="display:inline-block;padding:4px 12px 4px 10px;border-radius:999px;background:${tone.soft};color:${tone.text};font-size:13px;font-weight:600;line-height:20px">`,
    `<span style="color:${tone.accent}">&#9679;</span>&nbsp;${escapeHtml(content.pill)}</span>`,
    `<h1 class="cs-title" style="margin:16px 0 0;color:#09090b;font-size:24px;font-weight:700;line-height:32px;letter-spacing:-.01em">${escapeHtml(content.title)}</h1>`,
    content.lead
      ? `<p class="cs-muted" style="margin:8px 0 0;color:#71717a;font-size:14px;line-height:22px">${escapeHtml(content.lead)}</p>`
      : "",
    factsHtml
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;border-collapse:collapse">${factsHtml}</table>`
      : "",
    noteHtml,
    paragraphsHtml,
    content.cta ? button(content.cta.label, content.cta.url) : "",
    fallbackHtml,
    `</td></tr></table></td></tr>`,
    // Footer.
    `<tr><td style="padding:24px 8px 0;color:#71717a;font-size:12px;line-height:18px" class="cs-muted">`,
    footerLinksHtml ? `<p style="margin:0 0 10px">${footerLinksHtml}</p>` : "",
    content.footer ? `<p style="margin:0 0 6px">${escapeHtml(content.footer)}</p>` : "",
    content.showUtcNote
      ? `<p style="margin:0 0 6px">${escapeHtml(LABELS.utcNote[content.locale])}</p>`
      : "",
    `<p style="margin:0">${escapeHtml(BRAND[content.locale])} · ${escapeHtml(LABELS.relay[content.locale])}</p>`,
    `</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("")
}

function renderText(content: MailContent): string {
  const lines = [`${BRAND[content.locale]} · ${content.eyebrow}`, "", content.title, content.pill]
  if (content.lead) lines.push(content.lead)
  if (content.facts.length > 0) lines.push("")
  for (const [label, value] of content.facts)
    lines.push(`${label}: ${factText(value, content.locale)}`)
  if (content.note) {
    lines.push("")
    if (content.note.label) lines.push(`${content.note.label}:`)
    lines.push(content.note.body)
  }
  for (const paragraph of content.paragraphs) lines.push("", paragraph)
  if (content.cta) lines.push("", `${content.cta.label}: ${content.cta.url}`)
  if (content.footerLinks.length > 0) lines.push("")
  for (const link of content.footerLinks) lines.push(`${link.label}: ${link.url}`)
  lines.push("", "—")
  if (content.footer) lines.push(content.footer)
  if (content.showUtcNote) lines.push(LABELS.utcNote[content.locale])
  lines.push(`${BRAND[content.locale]} · ${LABELS.relay[content.locale]}`)
  return lines.join("\n")
}

function compose(content: MailContent): RenderedMail {
  return { subject: content.subject, text: renderText(content), html: renderHtml(content) }
}

/** Status page link, then manage and unsubscribe, for the footer row. */
function footerLinks(
  locale: StatusLocale,
  links: MailLinks,
  includeDetail: boolean
): Array<{ label: string; url: string }> {
  const out = includeDetail ? [{ label: LABELS.statusPage[locale], url: links.detailUrl }] : []
  if (links.manageUrl) out.push({ label: LABELS.manage[locale], url: links.manageUrl })
  if (links.unsubscribeUrl)
    out.push({ label: LABELS.unsubscribe[locale], url: links.unsubscribeUrl })
  return out
}

// ---------------------------------------------------------------------------
// Mails
// ---------------------------------------------------------------------------

export function renderIncidentMail(
  payload: IncidentEventPayload,
  locale: StatusLocale,
  links: MailLinks
): RenderedMail {
  const title = pickLocalized(payload.title, locale)
  const state = STATE_LABELS[payload.state][locale]
  const impact = IMPACT_LABELS[payload.impact][locale]
  const message = pickLocalized(payload.message, locale)
  return compose({
    locale,
    subject: `[${BRAND[locale]}] ${state}: ${title}`,
    tone: incidentTone(payload),
    eyebrow: INCIDENT_PHASES[payload.phase][locale],
    pill: state,
    title,
    lead: formatUtc(payload.atMs, locale),
    facts: [
      [LABELS.impact[locale], { kind: "text", value: impact }],
      [
        LABELS.components[locale],
        { kind: "chips", values: componentNames(payload.componentIds, locale) },
      ],
    ],
    note: message ? { label: LABELS.update[locale], body: message } : null,
    paragraphs: [],
    cta: { label: LABELS.details[locale], url: links.detailUrl },
    ctaFallback: null,
    footerLinks: footerLinks(locale, links, false),
    footer: LABELS.footer[locale],
    showUtcNote: true,
    preheader: preheaderText(`${state} · ${impact} — ${message || title}`),
  })
}

export function renderMaintenanceMail(
  payload: MaintenanceEventPayload,
  locale: StatusLocale,
  links: MailLinks
): RenderedMail {
  const title = pickLocalized(payload.title, locale)
  const phaseKey: MaintenancePhaseKey =
    payload.phase === "ended" && payload.endKind ? payload.endKind : payload.phase
  const phase = MAINTENANCE_PHASES[phaseKey][locale]
  const window = formatUtcWindow(payload.startsAtMs, payload.endsAtMs, locale)
  // The window is the lead line under the title; the pill carries the phase.
  const facts: MailContent["facts"] = [
    [
      LABELS.components[locale],
      { kind: "chips", values: componentNames(payload.componentIds, locale) },
    ],
  ]
  if (payload.actualEndAtMs !== null)
    facts.push([
      LABELS.actualEnd[locale],
      { kind: "text", value: formatUtc(payload.actualEndAtMs, locale) },
    ])
  const description = pickLocalized(payload.description, locale)
  const note = payload.message ? pickLocalized(payload.message, locale) : null
  return compose({
    locale,
    subject: `[${BRAND[locale]}] ${phase}: ${title}`,
    tone: maintenanceTone(phaseKey),
    eyebrow: locale === "zh-CN" ? "计划维护" : "Scheduled maintenance",
    pill: phase,
    title,
    lead: window,
    facts,
    note: note ? { label: LABELS.update[locale], body: note } : null,
    paragraphs: description ? [description] : [],
    cta: { label: LABELS.details[locale], url: links.detailUrl },
    ctaFallback: null,
    footerLinks: footerLinks(locale, links, false),
    footer: LABELS.footer[locale],
    showUtcNote: true,
    preheader: preheaderText(`${phase} — ${window}`),
  })
}

export function renderConfirmationMail(locale: StatusLocale, confirmUrl: string): RenderedMail {
  const zh = locale === "zh-CN"
  return compose({
    locale,
    subject: zh
      ? `[${BRAND[locale]}] 请确认您的订阅`
      : `[${BRAND[locale]}] Confirm your subscription`,
    tone: "neutral",
    eyebrow: zh ? "订阅确认" : "Confirm subscription",
    pill: zh ? "还差一步" : "One step left",
    title: zh ? "确认订阅 Cognia 状态通知" : "Confirm your Cognia status subscription",
    lead: null,
    facts: [],
    note: null,
    paragraphs: [
      zh
        ? "点击下方按钮，并在打开的页面上确认，即可开始接收 Cognia 官方托管中继的事件与维护通知。"
        : "Press the button below and confirm on the page that opens to start receiving incident and maintenance notifications for Cognia's official hosted relay.",
      zh
        ? "链接 24 小时内有效。如果这不是您本人的操作，请忽略此邮件，您不会收到任何通知。"
        : "The link is valid for 24 hours. If you did not ask for this, ignore this email and you will receive nothing further.",
    ],
    cta: { label: zh ? "确认订阅" : "Confirm subscription", url: confirmUrl },
    ctaFallback: zh
      ? "如果按钮无法点击，请复制以下链接到浏览器中打开："
      : "If the button does not work, copy this link into your browser:",
    footerLinks: [],
    footer: null,
    showUtcNote: false,
    preheader: zh
      ? "点击确认，开始接收 Cognia 状态通知。链接 24 小时内有效。"
      : "Confirm to start receiving Cognia status notifications. The link is valid for 24 hours.",
  })
}

export function renderWelcomeMail(
  locale: StatusLocale,
  links: MailLinks,
  purpose: "welcome" | "manage_link"
): RenderedMail {
  const zh = locale === "zh-CN"
  if (purpose === "welcome") {
    return compose({
      locale,
      subject: zh ? `[${BRAND[locale]}] 订阅已确认` : `[${BRAND[locale]}] Subscription confirmed`,
      tone: "operational",
      eyebrow: zh ? "订阅已确认" : "Subscription confirmed",
      pill: zh ? "已订阅" : "Subscribed",
      title: zh ? "您已订阅 Cognia 状态通知" : "You're subscribed to Cognia status",
      lead: null,
      facts: [
        [
          zh ? "您会收到" : "You'll hear about",
          {
            kind: "chips",
            values: zh
              ? ["事件开始", "事件进展", "事件解决", "计划维护"]
              : ["New incidents", "Incident updates", "Resolutions", "Scheduled maintenance"],
          },
        ],
      ],
      note: null,
      paragraphs: [
        zh
          ? "官方托管中继出现事件或安排维护时，我们会第一时间通知您。每封邮件都附有修改偏好和退订的链接。"
          : "We will email you when the official hosted relay has an incident or scheduled maintenance. Every email carries links to change your preferences or unsubscribe.",
      ],
      cta: { label: zh ? "查看当前状态" : "View current status", url: links.detailUrl },
      ctaFallback: null,
      footerLinks: footerLinks(locale, links, false),
      footer: LABELS.footer[locale],
      showUtcNote: false,
      preheader: zh
        ? "订阅已确认。发生事件或计划维护时，我们会通知您。"
        : "You're all set. We'll email you about incidents and scheduled maintenance.",
    })
  }
  return compose({
    locale,
    subject: zh ? `[${BRAND[locale]}] 管理您的订阅` : `[${BRAND[locale]}] Manage your subscription`,
    tone: "neutral",
    eyebrow: zh ? "订阅管理" : "Subscription",
    pill: zh ? "已订阅" : "Already subscribed",
    title: zh ? "此邮箱已订阅 Cognia 状态通知" : "This address is already subscribed",
    lead: null,
    facts: [],
    note: null,
    paragraphs: [
      zh
        ? "有人请求为此地址订阅 Cognia 状态通知，而该地址已经订阅。您可以通过下方按钮管理偏好或退订。"
        : "Someone asked to subscribe this address to Cognia status notifications, and it is already subscribed. Use the button below to manage your preferences or unsubscribe.",
      zh
        ? "如果这不是您本人的操作，无需处理，您的订阅不会改变。"
        : "If this was not you, no action is needed and nothing changes.",
    ],
    cta: links.manageUrl
      ? { label: LABELS.manage[locale], url: links.manageUrl }
      : { label: LABELS.statusPage[locale], url: links.detailUrl },
    ctaFallback: null,
    footerLinks: footerLinks(locale, links, true).filter((link) => link.url !== links.manageUrl),
    footer: LABELS.footer[locale],
    showUtcNote: false,
    preheader: zh
      ? "此地址已订阅。可在此管理偏好或退订。"
      : "This address is already subscribed. Manage preferences or unsubscribe here.",
  })
}
