import { setTimeout as delay } from "node:timers/promises"

import { feishuSign } from "../../../lib/notifications/delivery/feishu-webhook.ts"

const BODY_LIMIT = 18_000
const RESPONSE_LIMIT = 16_384
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RETRY_DELAY_MS = 30_000

function boundedText(value, maxBytes) {
  if (typeof value !== "string") return ""
  const source = value
    .slice(0, maxBytes * 2)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
  if (Buffer.byteLength(source) <= maxBytes && source.length === value.length) return source
  let text = ""
  let bytes = 0
  for (const character of source) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes - 3) break
    text += character
    bytes += size
  }
  return `${text}…`
}

function githubUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048) return null
  if (!/^https:\/\/github\.com\//.test(value) || /[\s\\]/.test(value)) return null
  try {
    const parsed = new URL(value)
    return parsed.hostname === "github.com" && !parsed.username && !parsed.password && !parsed.port
      ? parsed.href
      : null
  } catch {
    return null
  }
}

function textBlock(content, textSize = "normal", textColor = "default") {
  return {
    tag: "div",
    text: { tag: "plain_text", content, text_size: textSize, text_color: textColor },
  }
}

/**
 * Card JSON 2.0, matching the existing Lark presentation hierarchy without
 * importing the app runtime. Every source-owned string remains plain text.
 * https://open.feishu.cn/document/feishu-cards/card-json-v2-structure
 */
export function renderCard({
  title,
  level,
  subtitle,
  summary,
  tags = [],
  metrics = [],
  sections = [],
  lines = [],
  actions = [],
  footer,
} = {}) {
  let omitted = false
  function text(value, limit) {
    const source = typeof value === "number" && Number.isFinite(value) ? String(value) : value
    const result = boundedText(source, limit)
    if (typeof source === "string" && source !== result) omitted = true
    return result
  }
  function list(value, limit) {
    if (!Array.isArray(value)) return []
    if (value.length > limit) omitted = true
    return value.slice(0, limit)
  }
  function links(value) {
    const candidates = list(value, 30).flatMap((action) => {
      const url = githubUrl(action?.url ?? action?.ref)
      if (!url) {
        omitted = true
        return []
      }
      return [{ label: text(action.label, 80) || "GitHub", url }]
    })
    return list(candidates, 3)
  }
  const model = {
    title: text(title, 300) || "Cognia",
    subtitle: text(subtitle, 240),
    summary: text(summary, 800),
    tags: list(tags, 3)
      .map((tag) => text(tag, 60))
      .filter(Boolean),
    metrics: list(metrics, 6).map((metric) => ({
      label: text(metric?.label, 80),
      value: text(metric?.value, 160),
    })),
    lines: list(lines, 30)
      .map((line) => text(line, 800))
      .filter(Boolean),
    sections: list(sections, 6).map((section) => ({
      title: text(section?.title, 160) || "Details",
      lines: list(section?.lines, 16)
        .map((line) => text(line, 800))
        .filter(Boolean),
      actions: links(section?.actions),
    })),
    actions: links(actions),
    footer: text(footer, 300),
  }
  const template =
    level === "error"
      ? "red"
      : level === "warning"
        ? "orange"
        : level === "success"
          ? "green"
          : "blue"
  function build() {
    let primaryUsed = false
    function actionRow(items) {
      if (!items.length) return []
      return [
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "8px",
          columns: items.map((action) => {
            const type = primaryUsed ? "default" : "primary_filled"
            primaryUsed = true
            return {
              tag: "column",
              width: "auto",
              elements: [
                {
                  tag: "button",
                  type,
                  size: "medium",
                  text: { tag: "plain_text", content: action.label },
                  behaviors: [{ type: "open_url", default_url: action.url }],
                },
              ],
            }
          }),
        },
      ]
    }
    const elements = []
    if (model.summary) elements.push(textBlock(model.summary))
    for (let index = 0; index < model.metrics.length; index += 2) {
      elements.push({
        tag: "column_set",
        flex_mode: "bisect",
        horizontal_spacing: "12px",
        columns: model.metrics.slice(index, index + 2).map((metric) => ({
          tag: "column",
          width: "weighted",
          weight: 1,
          padding: "12px",
          background_style: "metric-surface",
          vertical_spacing: "4px",
          elements: [
            textBlock(metric.label, "notation", "grey"),
            textBlock(metric.value, "heading-2"),
          ],
        })),
      })
    }
    if (model.lines.length) elements.push(textBlock(model.lines.join("\n")))
    elements.push(...actionRow(model.actions))
    for (const section of model.sections) {
      elements.push({ tag: "hr" }, textBlock(section.title, "heading-4"))
      if (section.lines.length) elements.push(textBlock(section.lines.join("\n")))
      elements.push(...actionRow(section.actions))
    }
    if (omitted)
      elements.push(
        textBlock(
          "Some details were shortened or omitted. Open GitHub for the full result.",
          "notation",
          "grey"
        )
      )
    if (model.footer) elements.push({ tag: "hr" }, textBlock(model.footer, "notation", "grey"))
    if (!elements.length) elements.push(textBlock("Cognia workflow notification"))
    return {
      msg_type: "interactive",
      card: {
        schema: "2.0",
        config: {
          summary: { content: boundedText(model.summary || model.title, 300) },
          ...(model.metrics.length
            ? {
                style: {
                  color: {
                    "metric-surface": {
                      light_mode: "rgba(245,246,248,1)",
                      dark_mode: "rgba(35,38,45,1)",
                    },
                  },
                },
              }
            : {}),
        },
        header: {
          title: { tag: "plain_text", content: model.title },
          template,
          padding: "12px 16px",
          ...(model.subtitle ? { subtitle: { tag: "plain_text", content: model.subtitle } } : {}),
          ...(model.tags.length
            ? {
                text_tag_list: model.tags.map((tag) => ({
                  tag: "text_tag",
                  text: { tag: "plain_text", content: tag },
                  color: "neutral",
                })),
              }
            : {}),
        },
        body: { direction: "vertical", padding: "16px", vertical_spacing: "12px", elements },
      },
    }
  }
  let body = build()
  const oversized = () => Buffer.byteLength(JSON.stringify(body)) >= BODY_LIMIT - 256
  if (oversized()) {
    omitted = true
    model.summary = text(model.summary, 400)
    model.footer = text(model.footer, 120)
    model.lines = model.lines.map((line) => text(line, 160))
    for (const section of model.sections) {
      section.title = text(section.title, 100)
      section.lines = section.lines.map((line) => text(line, 160))
    }
    body = build()
  }
  // Preserve status, summary, main CTA and each section's first evidence line.
  // Optional secondary links and trailing detail are the first things to go.
  while (oversized()) {
    omitted = true
    const actionCount =
      model.actions.length +
      model.sections.reduce((count, section) => count + section.actions.length, 0)
    const actionSection = model.sections.findLast((section) => section.actions.length > 0)
    const detailSection = model.sections.findLast((section) => section.lines.length > 1)
    if (actionSection && actionCount > 1) actionSection.actions.pop()
    else if (model.lines.length > 1) model.lines.pop()
    else if (detailSection) detailSection.lines.pop()
    else if (model.actions.length > 1) model.actions.pop()
    else if (model.metrics.length > 2) model.metrics.pop()
    else if (model.sections.length > 1) model.sections.pop()
    else break // The remaining bounded skeleton is comfortably below the limit.
    body = build()
  }
  return body
}

function validTarget(value) {
  return (
    typeof value === "string" &&
    /^https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(
      value
    )
  )
}

function discard(response) {
  if (response.body) void response.body.cancel().catch(() => {})
}

async function readEnvelope(response) {
  if (!response.body) throw new Error("Missing response")
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > RESPONSE_LIMIT) throw new Error("Response too large")
      chunks.push(Buffer.from(chunk.value))
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function retryDelay(response, attempt, now) {
  const header = response.headers.get("retry-after")
  const supplied =
    header && /^\d+(?:\.\d+)?$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header ?? "") - now()
  // Preserve the provider's minimum wait, including numeric overflow. The
  // caller stops retrying when it cannot honor that wait within its budget.
  return Math.max(1000 * 2 ** (attempt - 1), Number.isNaN(supplied) ? 0 : supplied)
}

async function sendAttempt(url, body, fetchImpl, attempt, now) {
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("Webhook deadline exceeded"))
    }, REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          redirect: "error",
          signal: controller.signal,
        })
        if (response.status === 429) {
          discard(response)
          return { outcome: "rate-limited", retryMs: retryDelay(response, attempt, now) }
        }
        if (response.status < 200 || response.status >= 300) {
          discard(response)
          const outcome =
            response.status >= 500
              ? "delivery-unknown"
              : [401, 403].includes(response.status)
                ? "auth-failed"
                : [404, 410].includes(response.status)
                  ? "invalid-target"
                  : "rejected"
          return { outcome }
        }
        const envelope = await readEnvelope(response)
        const code = envelope?.code
        if (!Number.isSafeInteger(code)) return { outcome: "delivery-unknown" }
        if (code === 0) return { outcome: "accepted", code }
        if (code === 11232)
          return { outcome: "rate-limited", code, retryMs: retryDelay(response, attempt, now) }
        if ([19021, 19022].includes(code)) return { outcome: "auth-failed", code }
        return { outcome: "rejected", code }
      })(),
    ])
  } catch {
    // A lost acknowledgement may already have delivered the card. Retrying
    // would create duplicates; only explicit rate-limit responses are safe.
    return { outcome: "delivery-unknown" }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send signed custom-bot cards without ever returning secret-bearing errors.
 * The 10-second deadline covers each HTTP attempt and its response body, not
 * the entire retry sequence. At most three requests and two waits of up to
 * 30 seconds can occur (up to 90 seconds, plus local signing/scheduling time).
 */
export async function sendWebhook({
  url,
  secret,
  body,
  fetchImpl = fetch,
  sleep = delay,
  now = Date.now,
  maxAttempts = 3,
}) {
  if (!validTarget(url)) return { outcome: "invalid-target", attempts: 0 }
  if (typeof secret !== "string" || !secret.trim()) return { outcome: "auth-failed", attempts: 0 }
  let serialized
  try {
    serialized = JSON.stringify(body)
  } catch {
    throw new Error("Invalid Feishu notification body")
  }
  if (
    !body ||
    typeof body !== "object" ||
    !serialized ||
    Buffer.byteLength(serialized) >= BODY_LIMIT
  ) {
    throw new Error("Invalid Feishu notification body")
  }
  const attemptsLimit = Number.isFinite(maxAttempts)
    ? Math.min(3, Math.max(1, Math.floor(maxAttempts)))
    : 3
  for (let attempts = 1; attempts <= attemptsLimit; attempts++) {
    const timestamp = Math.floor(now() / 1000).toString()
    let sign
    try {
      sign = await feishuSign(timestamp, secret)
    } catch {
      throw new Error("Feishu signing failed")
    }
    const signed = JSON.stringify({ ...JSON.parse(serialized), timestamp, sign })
    const { retryMs, ...result } = await sendAttempt(url, signed, fetchImpl, attempts, now)
    if (
      result.outcome !== "rate-limited" ||
      attempts === attemptsLimit ||
      retryMs > MAX_RETRY_DELAY_MS
    )
      return { ...result, attempts }
    try {
      await sleep(retryMs)
    } catch {
      return { ...result, attempts }
    }
  }
}
