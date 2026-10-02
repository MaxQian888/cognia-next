/**
 * Atom and RSS feeds of incidents and maintenance (plan §8).
 *
 * - Bounded: the 50 most recently updated incidents and windows, each with
 *   at most its 10 latest updates.
 * - Stable IDs: Atom entries are `tag:` URIs per incident / window (Atom
 *   readers update an entry in place). RSS has no update semantics, so an
 *   RSS item's guid also names the revision: every public change appears as
 *   a new item instead of silently rewriting an old one.
 * - Text only: every value is XML-escaped plain text (`type="text"`),
 *   never HTML. English first; the zh-CN text follows as a second section
 *   when the operator provided it.
 * - Links point at the public page (`?incident=<id>` deep links).
 */

import type {
  ComponentId,
  IncidentImpact,
  IncidentState,
  LocalizedText,
  MaintenanceState,
  MaintenanceUpdateKind,
} from "../../../../../lib/status/contract"
import { statusIncidentPageUrl } from "../../../../../lib/status/config"
import type { Env } from "../env"
import { parseJsonColumn } from "../incidents/ids"
import { COMPONENT_LABELS } from "../incidents/templates"

export const FEED_ENTRY_LIMIT = 50
export const FEED_UPDATES_PER_ENTRY = 10

interface FeedUpdate {
  atMs: number
  label: { en: string; "zh-CN": string }
  message: LocalizedText | null
}

export interface FeedEntry {
  kind: "incident" | "maintenance"
  id: string
  revision: number
  title: LocalizedText
  statusLabel: { en: string; "zh-CN": string }
  componentIds: ComponentId[]
  publishedMs: number
  updatedMs: number
  facts: Array<{ en: string; "zh-CN": string }>
  updates: FeedUpdate[]
  link: string
}

const INCIDENT_STATES: Record<IncidentState, { en: string; "zh-CN": string }> = {
  investigating: { en: "Investigating", "zh-CN": "调查中" },
  identified: { en: "Identified", "zh-CN": "已确定原因" },
  monitoring: { en: "Monitoring", "zh-CN": "观察中" },
  resolved: { en: "Resolved", "zh-CN": "已解决" },
}

const IMPACTS: Record<IncidentImpact, { en: string; "zh-CN": string }> = {
  degraded: { en: "Degraded performance", "zh-CN": "性能下降" },
  partial_outage: { en: "Partial outage", "zh-CN": "部分中断" },
  major_outage: { en: "Major outage", "zh-CN": "重大中断" },
}

const MAINTENANCE_STATES: Record<MaintenanceState, { en: string; "zh-CN": string }> = {
  scheduled: { en: "Scheduled maintenance", "zh-CN": "计划维护" },
  in_progress: { en: "Maintenance in progress", "zh-CN": "维护进行中" },
  awaiting_confirmation: { en: "Maintenance awaiting confirmation", "zh-CN": "维护待确认" },
  completed: { en: "Maintenance completed", "zh-CN": "维护已完成" },
  cancelled: { en: "Maintenance cancelled", "zh-CN": "维护已取消" },
}

const MAINTENANCE_KINDS: Record<MaintenanceUpdateKind, { en: string; "zh-CN": string }> = {
  scheduled: { en: "Scheduled", "zh-CN": "已计划" },
  started: { en: "Started", "zh-CN": "已开始" },
  extended: { en: "Extended", "zh-CN": "已延长" },
  rescheduled: { en: "Rescheduled", "zh-CN": "已改期" },
  awaiting_confirmation: { en: "Awaiting confirmation", "zh-CN": "待确认" },
  completed: { en: "Completed", "zh-CN": "已完成" },
  cancelled: { en: "Cancelled", "zh-CN": "已取消" },
  note: { en: "Note", "zh-CN": "备注" },
}

export function escapeXml(value: string): string {
  return (
    value
      // XML 1.0 forbids most control characters even when escaped.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  )
}

function utc(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function feedHost(env: Env): string {
  try {
    return new URL(env.PUBLIC_ORIGIN).host
  } catch {
    return "status.cognia.cn"
  }
}

export function entryTag(env: Env, entry: Pick<FeedEntry, "kind" | "id">): string {
  return `tag:${feedHost(env)},2026:${entry.kind}:${entry.id}`
}

function components(ids: readonly ComponentId[], locale: "en" | "zh-CN"): string {
  return ids.map((id) => COMPONENT_LABELS[id][locale]).join(locale === "zh-CN" ? "、" : ", ")
}

function hasChinese(entry: FeedEntry): boolean {
  return (
    Boolean(entry.title["zh-CN"]) ||
    entry.updates.some((update) => Boolean(update.message?.["zh-CN"]))
  )
}

/** Plain-text body: English, then the zh-CN section when present. */
export function entryText(entry: FeedEntry): string {
  const section = (locale: "en" | "zh-CN"): string[] => {
    const lines = [`${entry.statusLabel[locale]} · ${components(entry.componentIds, locale)}`]
    for (const fact of entry.facts) lines.push(fact[locale])
    lines.push("")
    for (const update of entry.updates) {
      const text = update.message
        ? locale === "zh-CN"
          ? update.message["zh-CN"] || update.message.en
          : update.message.en
        : ""
      lines.push(`${utc(update.atMs)} — ${update.label[locale]}${text ? `: ${text}` : ""}`)
    }
    return lines
  }
  const lines = section("en")
  if (hasChinese(entry)) {
    lines.push("", "— 简体中文 —", entry.title["zh-CN"] || entry.title.en, ...section("zh-CN"))
  }
  return lines.join("\n")
}

interface IncidentFeedRow {
  id: string
  title_json: string
  state: IncidentState
  impact: IncidentImpact
  component_ids_json: string
  started_at: number
  resolved_at: number | null
  updated_at: number
  revision: number
}

interface MaintenanceFeedRow {
  id: string
  title_json: string
  description_json: string
  component_ids_json: string
  state: MaintenanceState
  starts_at: number
  ends_at: number
  actual_end_at: number | null
  updated_at: number
  revision: number
}

async function incidentEntries(env: Env): Promise<FeedEntry[]> {
  const db = env.DB
  const rows = await db
    .prepare(
      `SELECT id, title_json, state, impact, component_ids_json, started_at, resolved_at, updated_at, revision
       FROM incidents ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
    .bind(FEED_ENTRY_LIMIT)
    .all<IncidentFeedRow>()
  if (rows.results.length === 0) return []
  const ids = rows.results.map((row) => row.id)
  const updates = await db
    .prepare(
      `SELECT incident_id, state, message_json, at FROM (
         SELECT incident_id, state, message_json, at,
                ROW_NUMBER() OVER (PARTITION BY incident_id ORDER BY seq DESC) AS rn
         FROM incident_updates WHERE incident_id IN (${ids.map(() => "?").join(", ")})
       ) WHERE rn <= ? ORDER BY incident_id, at DESC`
    )
    .bind(...ids, FEED_UPDATES_PER_ENTRY)
    .all<{ incident_id: string; state: IncidentState; message_json: string; at: number }>()
  return rows.results.map((row) => {
    const facts = [
      { en: `Impact: ${IMPACTS[row.impact].en}`, "zh-CN": `影响：${IMPACTS[row.impact]["zh-CN"]}` },
    ]
    facts.push({ en: `Started: ${utc(row.started_at)}`, "zh-CN": `开始：${utc(row.started_at)}` })
    if (row.resolved_at !== null) {
      facts.push({
        en: `Resolved: ${utc(row.resolved_at)}`,
        "zh-CN": `解决：${utc(row.resolved_at)}`,
      })
    }
    return {
      kind: "incident" as const,
      id: row.id,
      revision: row.revision,
      title: parseJsonColumn<LocalizedText>(row.title_json, "incidents.title_json"),
      statusLabel: INCIDENT_STATES[row.state],
      componentIds: parseJsonColumn<ComponentId[]>(
        row.component_ids_json,
        "incidents.component_ids_json"
      ),
      publishedMs: row.started_at,
      updatedMs: row.updated_at,
      facts,
      updates: updates.results
        .filter((update) => update.incident_id === row.id)
        .map((update) => ({
          atMs: update.at,
          label: INCIDENT_STATES[update.state],
          message: parseJsonColumn<LocalizedText>(
            update.message_json,
            "incident_updates.message_json"
          ),
        })),
      link: statusIncidentPageUrl(env.PUBLIC_PAGE_URL, row.id),
    }
  })
}

async function maintenanceEntries(env: Env): Promise<FeedEntry[]> {
  const db = env.DB
  const rows = await db
    .prepare(
      `SELECT id, title_json, description_json, component_ids_json, state, starts_at, ends_at, actual_end_at,
              updated_at, revision
       FROM maintenance ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
    .bind(FEED_ENTRY_LIMIT)
    .all<MaintenanceFeedRow>()
  if (rows.results.length === 0) return []
  const ids = rows.results.map((row) => row.id)
  const updates = await db
    .prepare(
      `SELECT maintenance_id, kind, message_json, at FROM (
         SELECT maintenance_id, kind, message_json, at,
                ROW_NUMBER() OVER (PARTITION BY maintenance_id ORDER BY seq DESC) AS rn
         FROM maintenance_updates WHERE maintenance_id IN (${ids.map(() => "?").join(", ")})
       ) WHERE rn <= ? ORDER BY maintenance_id, at DESC`
    )
    .bind(...ids, FEED_UPDATES_PER_ENTRY)
    .all<{
      maintenance_id: string
      kind: MaintenanceUpdateKind
      message_json: string | null
      at: number
    }>()
  return rows.results.map((row) => {
    const description = parseJsonColumn<LocalizedText>(
      row.description_json,
      "maintenance.description_json"
    )
    const facts = [
      {
        en: `Window: ${utc(row.starts_at)} – ${utc(row.ends_at)}`,
        "zh-CN": `时间窗口：${utc(row.starts_at)} – ${utc(row.ends_at)}`,
      },
    ]
    if (row.actual_end_at !== null) {
      facts.push({
        en: `Actual end: ${utc(row.actual_end_at)}`,
        "zh-CN": `实际结束：${utc(row.actual_end_at)}`,
      })
    }
    facts.push({ en: description.en, "zh-CN": description["zh-CN"] || description.en })
    return {
      kind: "maintenance" as const,
      id: row.id,
      revision: row.revision,
      title: parseJsonColumn<LocalizedText>(row.title_json, "maintenance.title_json"),
      statusLabel: MAINTENANCE_STATES[row.state],
      componentIds: parseJsonColumn<ComponentId[]>(
        row.component_ids_json,
        "maintenance.component_ids_json"
      ),
      publishedMs: row.starts_at,
      updatedMs: row.updated_at,
      facts,
      updates: updates.results
        .filter((update) => update.maintenance_id === row.id)
        .map((update) => ({
          atMs: update.at,
          label: MAINTENANCE_KINDS[update.kind],
          message:
            update.message_json === null
              ? null
              : parseJsonColumn<LocalizedText>(
                  update.message_json,
                  "maintenance_updates.message_json"
                ),
        })),
      link: env.PUBLIC_PAGE_URL,
    }
  })
}

export async function loadFeedEntries(env: Env): Promise<FeedEntry[]> {
  const [incidents, maintenance] = await Promise.all([
    incidentEntries(env),
    maintenanceEntries(env),
  ])
  return [...incidents, ...maintenance]
    .sort((left, right) => right.updatedMs - left.updatedMs || right.id.localeCompare(left.id))
    .slice(0, FEED_ENTRY_LIMIT)
}

function entryTitle(entry: FeedEntry): string {
  return `[${entry.statusLabel.en}] ${entry.title.en}`
}

export function renderAtom(env: Env, entries: readonly FeedEntry[], nowMs: number): string {
  const updated = entries[0]?.updatedMs ?? nowMs
  const self = `${env.PUBLIC_ORIGIN.replace(/\/+$/, "")}/api/status/v1/feed.atom`
  const body = entries
    .map((entry) => {
      const latest = entry.updates[0]?.message?.en ?? entry.statusLabel.en
      return [
        "  <entry>",
        `    <id>${escapeXml(entryTag(env, entry))}</id>`,
        `    <title type="text">${escapeXml(entryTitle(entry))}</title>`,
        `    <published>${new Date(entry.publishedMs).toISOString()}</published>`,
        `    <updated>${new Date(entry.updatedMs).toISOString()}</updated>`,
        `    <link rel="alternate" type="text/html" href="${escapeXml(entry.link)}"/>`,
        `    <summary type="text">${escapeXml(latest)}</summary>`,
        `    <content type="text">${escapeXml(entryText(entry))}</content>`,
        "  </entry>",
      ].join("\n")
    })
    .join("\n")
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">`,
    `  <id>${escapeXml(`tag:${feedHost(env)},2026:feed`)}</id>`,
    `  <title type="text">Cognia Status</title>`,
    `  <subtitle type="text">Incidents and maintenance for the Cognia signaling and relay service</subtitle>`,
    `  <updated>${new Date(updated).toISOString()}</updated>`,
    `  <author><name>Cognia</name></author>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(env.PUBLIC_PAGE_URL)}"/>`,
    body,
    `</feed>`,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export function renderRss(env: Env, entries: readonly FeedEntry[], nowMs: number): string {
  const updated = entries[0]?.updatedMs ?? nowMs
  const self = `${env.PUBLIC_ORIGIN.replace(/\/+$/, "")}/api/status/v1/feed.rss`
  const items = entries
    .map((entry) =>
      [
        "    <item>",
        `      <title>${escapeXml(entryTitle(entry))}</title>`,
        `      <link>${escapeXml(entry.link)}</link>`,
        `      <guid isPermaLink="false">${escapeXml(`${entryTag(env, entry)}:r${entry.revision}`)}</guid>`,
        `      <pubDate>${new Date(entry.updatedMs).toUTCString()}</pubDate>`,
        `      <description>${escapeXml(entryText(entry))}</description>`,
        "    </item>",
      ].join("\n")
    )
    .join("\n")
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
    "  <channel>",
    "    <title>Cognia Status</title>",
    `    <link>${escapeXml(env.PUBLIC_PAGE_URL)}</link>`,
    "    <description>Incidents and maintenance for the Cognia signaling and relay service</description>",
    "    <language>en</language>",
    `    <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>`,
    items,
    "  </channel>",
    "</rss>",
  ]
    .filter((line) => line !== "")
    .join("\n")
}
