/**
 * Lark card serialiser — Task 82.
 *
 * Converts MessageSegments to Lark API request body shapes
 * (im_v1 cards 2.0 / text / post / image).
 *
 * Lark markdown special chars that need escaping:
 *   \  →  \\
 *   @  →  \@  (would otherwise trigger a mention)
 *
 * Lark supports: **bold**, *italic*, [link](url), line breaks (\n).
 */

import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import {
  buildActionId,
  recordCallbackBinding,
  walkA2UISurface,
  type A2UIWalkNode,
  bindingHintFields,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"

// ---------------------------------------------------------------------------
// Lark message body shape (im/v1/messages)
// ---------------------------------------------------------------------------

export type LarkMsgType = "text" | "interactive" | "image" | "post" | "audio" | "media" | "file"

export interface LarkMessageBody {
  msg_type: LarkMsgType
  /** JSON-stringified content per msg_type. */
  content: string
}

// ---------------------------------------------------------------------------
// Markdown escape
// ---------------------------------------------------------------------------

/**
 * Escape characters that Lark markdown treats specially.
 *
 * Lark uses @ for mentions and \ as an escape character.
 * We escape both so that user text containing these is rendered literally.
 */
export function escapeLarkMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/@/g, "\\@")
}

function usesCommandFrame(surfaceId: string): boolean {
  return /^(help:|welcome:|schedule-list-)/.test(surfaceId)
}

/** Shared Card 2.0 frame for command replies and help/welcome surfaces. */
export function buildLarkCommandFrame(
  title: string,
  elements: Record<string, unknown>[],
  tone: "info" | "success" | "warning" = "info"
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: {
      title: { tag: "plain_text", content: title },
      template: tone === "warning" ? "orange" : tone === "success" ? "green" : "blue",
      padding: "12px 16px 12px 16px",
    },
    body: { padding: "16px", vertical_spacing: "12px", elements },
  }
}

/** Preserve every reply line while making command syntax easy to scan. */
export function buildLarkCommandReply(
  command: string,
  text: string,
  outcome: "applied" | "denied" | "unknown"
): MessageSegment {
  const read = ["commands", "status", "sessions", "dir", "tasks", "agent"].includes(command)
  const tone = outcome !== "applied" ? "warning" : read ? "info" : "success"
  const label =
    outcome === "denied"
      ? "未执行 · Not applied"
      : outcome === "unknown"
        ? "未知命令 · Unknown command"
        : "命令回复 · Command reply"
  // Escape dynamic values, including card mention tags, before adding styling.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_\[\]])/g, "\\$1")
  const lines = escaped.split("\n").map((line) => {
    const field = line.match(/^(•\s+)([^:]+):\s*(.*)$/)
    if (field) return `${field[1]}**${field[2]}**: ${field[3]}`
    const commandLine = line.match(/^(•\s+)(\/[^—]+) — (.*)$/)
    if (commandLine) return `**${commandLine[2].trim()}**\n${commandLine[3]}`
    return line.endsWith(":") ? `**${line.slice(0, -1)}**` : line
  })
  const elements: Record<string, unknown>[] = []
  // Bound the component count; long output stays intact in the final block.
  for (let i = 0; i < lines.length; i += 8) {
    elements.push({ tag: "markdown", content: lines.slice(i, i + 8).join("\n") })
  }
  const bounded = elements.length > 24 ? [{ tag: "markdown", content: escaped }] : elements
  return {
    type: "card",
    card: { kind: "lark", payload: buildLarkCommandFrame(`/${command} · ${label}`, bounded, tone) },
  }
}

// ---------------------------------------------------------------------------
// Segment → Lark body
// ---------------------------------------------------------------------------

/**
 * Render a single MessageSegment as a LarkMessageBody.
 *
 * Voice/video/file/image segments must already carry a Lark-resolved key
 * (no `://` in the URL) — `resolveLarkMediaKeys` in `upload.ts` performs
 * the upload pre-pass. Segments whose URL is still a remote URL fall back
 * to a text-link rendering so the message is never silently dropped.
 *
 * `reply`, `emoji`, `location`, `poll` have no native Lark representation
 * and return null (the multi-segment combiner emits a `[type]` placeholder).
 */
export function segmentToLarkBody(seg: MessageSegment): LarkMessageBody | null {
  switch (seg.type) {
    case "text":
      return {
        msg_type: "text",
        content: JSON.stringify({ text: seg.text }),
      }

    case "markdown": {
      const escaped = escapeLarkMarkdown(seg.md)
      return {
        msg_type: "interactive",
        content: JSON.stringify({
          schema: "2.0",
          body: { elements: [{ tag: "markdown", content: escaped }] },
        }),
      }
    }

    case "image":
      // image_key body when the upload pre-pass has resolved the key;
      // otherwise fall back to a text-link rendering.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "image",
          content: JSON.stringify({ image_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[image](${seg.url})` }),
      }

    case "voice":
      // Lark requires opus voice via msg_type=audio + file_key. The upload
      // pre-pass resolves the key; bare URLs degrade to a text-link.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "audio",
          content: JSON.stringify({ file_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[voice](${seg.url})` }),
      }

    case "video":
      // msg_type=media for short-video file_keys. Bare URLs degrade to text.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "media",
          content: JSON.stringify({ file_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[video](${seg.url})` }),
      }

    case "file":
      // msg_type=file requires the uploaded file_key + file_name; URLs
      // degrade to a markdown-style link in text.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "file",
          content: JSON.stringify({ file_key: seg.url, file_name: seg.name }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[${seg.name}](${seg.url})` }),
      }

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      return {
        msg_type: "text",
        content: JSON.stringify({ text: block }),
      }
    }

    case "mention":
      // Documented text-message mention syntax: the ATTRIBUTE is `user_id`
      // (its value may be an open_id / user_id, or "all"); the inner text is
      // the fallback display name. `<at open_id="…">` is not documented and
      // renders as literal text.
      return {
        msg_type: "text",
        content: JSON.stringify({
          text: `<at user_id="${seg.userId}">${seg.displayName ?? ""}</at>`,
        }),
      }

    case "card": {
      // Platform-native card passthrough: when the opaque payload already
      // looks like Lark interactive-card JSON, ship it verbatim as
      // msg_type=interactive (this is what `send.card` + `rich-card.lark`
      // declare). Foreign card dialects (Slack Block Kit, …) keep the
      // plain-text placeholder.
      if (isLarkCardPayload(seg.card?.payload)) {
        return {
          msg_type: "interactive",
          content: JSON.stringify(seg.card.payload),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: "[card]" }),
      }
    }

    case "a2ui":
      // Sync fallback: plain text mirror. `serializeOutboundAsync`
      // routes a2ui segments through `buildLarkA2UICard` for the full
      // Lark Interactive Card projection.
      return {
        msg_type: "text",
        content: JSON.stringify({ text: seg.plainTextMirror }),
      }

    case "reply":
    case "emoji":
    case "location":
    case "poll":
      return null

    default:
      return null
  }
}

/**
 * Duck-type check for Lark interactive-card JSON: a card body has an
 * `elements` array (v1), locale-keyed `i18n_elements`, a `header` object,
 * or a Card 2.0 `schema` marker. Exported so the upload pre-pass
 * (`resolveLarkMediaKeys`) can find `img` elements inside card payloads
 * without re-implementing the detection.
 */
export function isLarkCardPayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false
  const p = payload as Record<string, unknown>
  return (
    Array.isArray(p["elements"]) ||
    (typeof p["i18n_elements"] === "object" && p["i18n_elements"] !== null) ||
    (typeof p["header"] === "object" && p["header"] !== null) ||
    typeof p["schema"] === "string" ||
    (p.type === "template" && isRecord(p.data) && typeof p.data.template_id === "string")
  )
}

// ---------------------------------------------------------------------------
// Lark A2UI mapper — Interactive Card projection (G3.4)
// ---------------------------------------------------------------------------

export interface LarkA2UIMapperInput {
  adapterId: string
  surfaceId: string
  surface: A2UISegmentContent
  conversationKey?: string
}

interface LarkCardElement {
  tag: string
  [k: string]: unknown
}

/** Project the resolved A2UI tree to Card 2.0 while preserving callback bindings. */
export async function buildLarkA2UICard(input: LarkA2UIMapperInput): Promise<LarkMessageBody> {
  const nodes = new Map<string, A2UIWalkNode>()
  walkA2UISurface(input.surface, (node) => nodes.set(node.id, node))
  const visited = new Set<string>()
  let header: { title: { content: string; tag: string } } | undefined
  let tableCount = 0
  const plain = (content: string) => ({ tag: "plain_text", content })
  const markdown = (content: string): LarkCardElement => ({ tag: "markdown", content })
  const formName = (id: string) => JSON.stringify([input.surfaceId, id])
  const callback = async (node: A2UIWalkNode, extra: Record<string, unknown> = {}) => {
    const action = stringValue(node.raw.action) || node.id
    const actionId = buildActionId(input.surfaceId, node.id, action)
    await recordCallbackBinding({
      adapterId: input.adapterId,
      actionId,
      surfaceId: input.surfaceId,
      componentId: node.id,
      conversationKey: input.conversationKey,
      ...bindingHintFields(node.raw),
    })
    return [
      {
        type: "callback",
        value: { actionId, surfaceId: input.surfaceId, componentId: node.id, ...extra },
      },
    ]
  }
  const render = async (id: string, inForm = false, depth = 0): Promise<LarkCardElement[]> => {
    if (visited.has(id)) return []
    visited.add(id)
    const node = nodes.get(id)
    if (!node) return []
    const raw = node.raw
    const children = async (form = inForm, level = depth) => {
      const result: LarkCardElement[] = []
      for (const child of node.childIds) result.push(...(await render(child, form, level)))
      return result
    }
    const label = stringValue(raw.label) || stringValue(raw.placeholder)
    const common = {
      ...(raw.disabled === true ? { disabled: true } : {}),
      ...(inForm
        ? { name: formName(id), ...(raw.required === true ? { required: true } : {}) }
        : {}),
    }
    switch (node.component) {
      case "Card": {
        const title = stringValue(raw.title)
        const result: LarkCardElement[] = []
        if (title && !header) header = { title: plain(title) }
        else if (title) result.push(markdown(`**${escapeLarkMarkdown(title)}**`))
        if (raw.description) result.push(markdown(escapeLarkMarkdown(stringValue(raw.description))))
        return [...result, ...(await children())]
      }
      case "Text": {
        const text = escapeLarkMarkdown(stringValue(raw.text))
        return text
          ? [markdown(/^heading[123]$/.test(stringValue(raw.variant)) ? `**${text}**` : text)]
          : []
      }
      case "Link":
        return raw.href
          ? [
              markdown(
                `[${escapeLarkMarkdown(stringValue(raw.text) || stringValue(raw.href))}](${stringValue(raw.href)})`
              ),
            ]
          : []
      case "Alert":
        return [
          markdown(
            `⚠️ **${escapeLarkMarkdown(stringValue(raw.title) || "Alert")}** ${escapeLarkMarkdown(stringValue(raw.message) || stringValue(raw.text))}`
          ),
        ]
      case "Divider":
        return [{ tag: "hr" }]
      case "Image": {
        const src = stringValue(raw.src) || stringValue(raw.url)
        if (!src) return []
        const alt = stringValue(raw.alt) || "image"
        return [
          src.includes("://")
            ? markdown(`[${escapeLarkMarkdown(alt)}](${src})`)
            : { tag: "img", img_key: src, alt: plain(alt) },
        ]
      }
      case "Button": {
        const href = stringValue(raw.href) || stringValue(raw.url)
        const action = stringValue(raw.action)
        const formAction = inForm
          ? raw.formAction === "reset" || action === "reset"
            ? "reset"
            : raw.formAction === "submit" || action === "submit" || action === "formSubmit"
              ? "submit"
              : undefined
          : undefined
        return [
          {
            tag: "button",
            ...common,
            text: plain(stringValue(raw.text) || action || "Button"),
            type:
              raw.variant === "primary"
                ? "primary"
                : raw.variant === "destructive"
                  ? "danger"
                  : "default",
            ...(formAction ? { form_action_type: formAction } : {}),
            ...(formAction === "reset"
              ? {}
              : {
                  behaviors: href
                    ? [{ type: "open_url", default_url: href }]
                    : await callback(node, inForm ? { formNames: true } : {}),
                }),
          },
        ]
      }
      case "Checkbox":
        return [
          {
            tag: "checker",
            ...common,
            checked:
              raw.checked === true ||
              (raw.checked === undefined && (raw.value === true || raw.value === "true")),
            text: plain(label || stringValue(raw.text) || "Checkbox"),
            behaviors: await callback(node),
          },
        ]
      case "TextField":
      case "TextArea":
        return [
          {
            tag: "input",
            ...common,
            placeholder: plain(label || "Input"),
            ...(raw.label ? { label: plain(stringValue(raw.label)) } : {}),
            default_value: stringValue(raw.value),
            input_type:
              node.component === "TextArea"
                ? "multiline_text"
                : raw.type === "password"
                  ? "password"
                  : "text",
            ...(node.component === "TextArea"
              ? { rows: Math.max(1, Math.min(20, Math.floor(Number(raw.rows) || 5))) }
              : {}),
            ...(typeof raw.maxLength === "number"
              ? { max_length: Math.max(1, Math.min(1000, Math.floor(raw.maxLength))) }
              : {}),
            behaviors: await callback(node),
          },
        ]
      case "Select":
      case "RadioGroup": {
        const options = Array.isArray(raw.options)
          ? raw.options
              .filter(isRecord)
              .filter((o) => typeof o.value === "string" || typeof o.value === "number")
              .map((o) => ({
                text: plain(stringValue(o.label) || stringValue(o.value)),
                value: String(o.value),
              }))
          : []
        if (!options.length) return [markdown(label || "Select")]
        const multiple = raw.multiple === true
        const selected = (Array.isArray(raw.value) ? raw.value : [raw.value])
          .map(stringValue)
          .filter((v) => options.some((o) => o.value === v))
        const control: LarkCardElement = {
          tag: multiple ? "multi_select_static" : "select_static",
          ...common,
          placeholder: plain(label || "Select"),
          options,
          ...(multiple
            ? { name: formName(id), selected_values: selected, required: raw.required === true }
            : {
                ...(selected[0] ? { initial_option: selected[0] } : {}),
                behaviors: await callback(node),
              }),
        }
        if (multiple && !inForm) {
          // Multi-select is legal only inside a form. A one-field form keeps
          // the canonical Select callback when the user submits the choices.
          return [
            {
              tag: "form",
              name: formName(`${id}:form`),
              elements: [
                control,
                {
                  tag: "button",
                  name: formName(`${id}:submit`),
                  text: plain("Submit"),
                  form_action_type: "submit",
                  behaviors: await callback(node, { selectField: formName(id) }),
                },
              ],
            },
          ]
        }
        return [control]
      }
      case "DatePicker":
      case "TimePicker":
      case "DateTimePicker": {
        const kind =
          node.component === "DatePicker"
            ? "date"
            : node.component === "TimePicker"
              ? "time"
              : "datetime"
        const initial = stringValue(raw.value)
        // Card initial values are wall-clock strings, not ISO timestamps.
        // Omit zone-bearing datetimes rather than silently changing their zone.
        const valid =
          kind === "date"
            ? /^\d{4}-\d{2}-\d{2}$/.test(initial)
            : kind === "time"
              ? /^\d{2}:\d{2}$/.test(initial)
              : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(initial)
        return [
          {
            tag: `picker_${kind}`,
            ...common,
            placeholder: plain(label || "Select"),
            ...(valid ? { [`initial_${kind}`]: initial.replace("T", " ") } : {}),
            behaviors: await callback(node),
          },
        ]
      }
      case "FormGroup": {
        const contents = await children(true, depth + 1)
        const prefix = [raw.legend, raw.description]
          .filter(Boolean)
          .map((v) => markdown(escapeLarkMarkdown(stringValue(v))))
        if (inForm) return [...prefix, ...contents]
        const hasSubmit = (items: LarkCardElement[]): boolean =>
          items.some(
            (e) =>
              e.form_action_type === "submit" ||
              (Array.isArray(e.elements) && hasSubmit(e.elements)) ||
              (Array.isArray(e.columns) && hasSubmit(e.columns))
          )
        if (!hasSubmit(contents))
          contents.push({
            tag: "button",
            name: formName(`${id}:submit`),
            text: plain("Submit"),
            form_action_type: "submit",
            behaviors: await callback(node, { formNames: true }),
          })
        return [...prefix, { tag: "form", name: formName(id), elements: contents }]
      }
      case "Row": {
        const columns: LarkCardElement[][] = []
        for (const child of node.childIds) columns.push(await render(child, inForm, depth + 2))
        const rendered = columns.flat()
        // Tables and forms must remain at their legal root placement. Deep
        // layouts flatten before exceeding Feishu's five-container limit.
        if (depth >= 3 || containsTag(rendered, ["table", "form"])) return rendered
        return rendered.length
          ? [
              {
                tag: "column_set",
                flex_mode: "flow",
                columns: columns
                  .filter((c) => c.length)
                  .map((elements) => ({ tag: "column", width: "weighted", weight: 1, elements })),
              },
            ]
          : []
      }
      case "Collapsible": {
        const rendered = await children(inForm, depth + 1)
        if (depth >= 4 || containsTag(rendered, ["table", "form"]))
          return [markdown(`**${escapeLarkMarkdown(stringValue(raw.title))}**`), ...rendered]
        return [
          {
            tag: "collapsible_panel",
            expanded: raw.open === true || raw.defaultOpen === true,
            header: { title: plain(stringValue(raw.title) || "Details") },
            elements: rendered,
          },
        ]
      }
      case "Table": {
        const columns = Array.isArray(raw.columns) ? raw.columns.filter(isRecord) : []
        const rows = Array.isArray(raw.data) ? raw.data.filter(isRecord) : []
        const title = raw.title
          ? [markdown(`**${escapeLarkMarkdown(stringValue(raw.title))}**`)]
          : []
        // Root-only table placement and five-table/50-column limits are
        // platform constraints. Preserve all values as text outside them.
        if (inForm || tableCount >= 5 || columns.length > 50 || !columns.length)
          return [...title, markdown(JSON.stringify(rows))]
        tableCount++
        return [
          ...title,
          {
            tag: "table",
            page_size: Math.max(1, Math.min(10, Math.floor(Number(raw.pageSize) || 5))),
            columns: columns.map((c) => ({
              name: stringValue(c.key),
              display_name: stringValue(c.header),
              data_type: c.type === "number" ? "number" : "text",
              ...(c.align ? { horizontal_align: c.align } : {}),
            })),
            rows,
          },
        ]
      }
      case "Chart": {
        const data = Array.isArray(raw.data) ? raw.data.filter(isRecord) : []
        const type = stringValue(raw.chartType)
        if (inForm || !["bar", "line", "area", "pie", "donut", "scatter", "radar"].includes(type))
          return [markdown(JSON.stringify(data))]
        const xKey = stringValue(raw.xKey) || "name"
        const yKeys = Array.isArray(raw.yKeys)
          ? raw.yKeys.filter((v): v is string => typeof v === "string")
          : ["value"]
        const multi = yKeys.length > 1 && !["pie", "donut"].includes(type)
        const values = multi
          ? data.flatMap((d) => yKeys.map((k) => ({ category: d[xKey], series: k, value: d[k] })))
          : data
        const xField = multi ? "category" : xKey
        const yField = multi ? "value" : yKeys[0] || "value"
        return [
          {
            tag: "chart",
            chart_spec: {
              type: type === "donut" ? "pie" : type,
              data: { values },
              ...(["pie", "donut"].includes(type)
                ? {
                    categoryField: xField,
                    valueField: yField,
                    ...(type === "donut" ? { innerRadius: 0.6 } : {}),
                  }
                : type === "radar"
                  ? { categoryField: xField, valueField: yField }
                  : { xField, yField }),
              ...(multi ? { seriesField: "series" } : {}),
              ...(raw.title ? { title: { text: stringValue(raw.title) } } : {}),
              legends: { visible: raw.showLegend !== false },
              ...(Array.isArray(raw.colors) ? { color: raw.colors } : {}),
            },
          },
        ]
      }
      case "Dialog":
      case "Drawer":
      case "Sheet":
        return [
          { tag: "hr" },
          ...(raw.title ? [markdown(`**${escapeLarkMarkdown(stringValue(raw.title))}**`)] : []),
          ...(await children()),
        ]
      case "Column":
      case "List":
      case "ButtonGroup":
        return children()
      default:
        return [
          markdown(
            [
              `[${node.component}]`,
              stringValue(raw.title),
              stringValue(raw.label),
              stringValue(raw.text),
              stringValue(raw.value),
            ]
              .filter(Boolean)
              .join(" ")
          ),
          ...(await children()),
        ]
    }
  }
  const elements = await render(input.surface.rootId)
  if (!elements.length && !header)
    return { msg_type: "text", content: JSON.stringify({ text: "[empty]" }) }
  const card = usesCommandFrame(input.surfaceId)
    ? buildLarkCommandFrame(header?.title.content ?? input.surface.title ?? "Cognia", elements)
    : { schema: "2.0", ...(header ? { header } : {}), body: { elements } }
  return { msg_type: "interactive", content: JSON.stringify(boundGeneratedCard(card)) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function containsTag(elements: LarkCardElement[], tags: string[]): boolean {
  return elements.some(
    (e) =>
      tags.includes(e.tag) ||
      (Array.isArray(e.elements) && containsTag(e.elements, tags)) ||
      (Array.isArray(e.columns) && containsTag(e.columns, tags))
  )
}

/** Locally composed cards share one element-ID namespace. */
function uniqueMergedElementIds(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  const reserved = new Set<string>()
  const seen = new Set<string>()
  let next = 0
  const walk = (value: unknown, rename: boolean): unknown => {
    if (Array.isArray(value)) return value.map((child) => walk(child, rename))
    if (!isRecord(value)) return value
    const result = { ...value }
    if (typeof value.tag === "string" && typeof value.element_id === "string") {
      if (!rename) reserved.add(value.element_id)
      else if (seen.has(value.element_id)) {
        let id: string
        do {
          id = `merged_${next++}`
        } while (reserved.has(id))
        result.element_id = id
        reserved.add(id)
      } else seen.add(value.element_id)
    }
    for (const key of ["elements", "columns", "header", "title", "text"]) {
      if (value[key]) result[key] = walk(value[key], rename)
    }
    return result
  }
  walk(elements, false)
  return walk(elements, true) as Record<string, unknown>[]
}

/** Card 2.0 counts text/option nodes too; keep oversized replies readable. */
function boundGeneratedCard(card: Record<string, unknown>): Record<string, unknown> {
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum, child) => sum + count(child), 0)
    if (!isRecord(value)) return 0
    return (
      (typeof value.tag === "string" ? 1 : 0) +
      Object.entries(value)
        .filter(
          ([key]) =>
            key !== "behaviors" && key !== "value" && key !== "chart_spec" && key !== "rows"
        )
        .reduce((sum, [, child]) => sum + count(child), 0)
    )
  }
  if (count(card) <= 200 || !isRecord(card.body) || !Array.isArray(card.body.elements)) return card
  const text = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n")
    if (!isRecord(value)) return stringValue(value)
    if (value.tag === "table")
      return [text(value.columns), JSON.stringify(value.rows)].filter(Boolean).join("\n")
    if (value.tag === "chart" && isRecord(value.chart_spec))
      return [text(value.chart_spec.title), JSON.stringify(value.chart_spec.data)].join("\n")
    if (value.tag === "hr") return "---"
    return [
      value.content,
      value.text,
      value.title,
      value.header,
      value.label,
      value.display_name,
      value.placeholder,
      value.default_value,
      value.selected_values,
      value.initial_option,
      typeof value.checked === "boolean" ? (value.checked ? "[x]" : "[ ]") : undefined,
      value.options,
      value.elements,
      value.columns,
      value.alt,
    ]
      .map(text)
      .filter(Boolean)
      .join("\n")
  }
  return {
    ...card,
    body: {
      ...card.body,
      elements: [
        {
          tag: "markdown",
          content:
            "卡片超过 200 个元素，交互控件以文本展示。 / This card exceeds 200 elements; controls are shown as text.\n\n" +
            text(card.body.elements),
        },
      ],
    },
  }
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

/**
 * Async serializer used by the production adapter `send()`. When a
 * segment list contains any `a2ui` segment — or mixes a `markdown`
 * segment with other segments — the whole message collapses into a
 * single Lark Interactive Card (composed from each a2ui surface + the
 * text/markdown/code tail). Otherwise delegates to the sync
 * `segmentsToLarkBody`.
 *
 * The markdown trigger exists because markdown only renders via a card
 * `lark_md` element: the sync multi-segment combiner degrades it to a
 * literal "[markdown]" placeholder inside a text body, so a
 * text+markdown+code answer used to arrive visibly broken.
 *
 * Lark's `/im/v1/messages` accepts one body per call, so combining
 * everything into a single interactive card preserves the assistant's
 * intended layout without an extra round-trip.
 */
export async function segmentsToLarkBodyAsync(
  segments: MessageSegment[],
  ctx: {
    adapterId: string
    /** Conversation key persisted on each callback binding row. */
    conversationKey?: string
  }
): Promise<LarkMessageBody> {
  const single = segments.length === 1 ? segments[0] : undefined
  if (single?.type === "a2ui" && usesCommandFrame(single.surfaceId)) {
    return buildLarkA2UICard({ ...ctx, surfaceId: single.surfaceId, surface: single.content })
  }
  const hasA2UI = segments.some((s) => s.type === "a2ui")
  // A single markdown segment already renders as its own interactive card
  // via `segmentToLarkBody`; only multi-segment markdown needs the combiner.
  const needsMarkdownCard = segments.length > 1 && segments.some((s) => s.type === "markdown")
  const hasNativeCard =
    segments.length > 1 &&
    segments.some((seg) => seg.type === "card" && isLarkCardPayload(seg.card.payload))
  if (!hasA2UI && !needsMarkdownCard && !hasNativeCard) return segmentsToLarkBody(segments)

  // Compose a single interactive card that interleaves text/markdown
  // segments as Card 2.0 markdown elements with each a2ui surface's projected
  // elements. Header taken from the first a2ui surface's `title`.
  const combinedElements: Record<string, unknown>[] = []
  let header: Record<string, unknown> | undefined
  let config: Record<string, unknown> | undefined
  let bodyLayout: Record<string, unknown> = {}

  for (const seg of segments) {
    if (seg.type === "a2ui") {
      const body = await buildLarkA2UICard({
        adapterId: ctx.adapterId,
        surfaceId: seg.surfaceId,
        surface: seg.content,
        conversationKey: ctx.conversationKey,
      })
      if (body.msg_type === "interactive") {
        const parsed = JSON.parse(body.content) as {
          header?: Record<string, unknown>
          body?: { elements?: Record<string, unknown>[] }
        }
        if (!header && parsed.header) header = parsed.header
        if (parsed.body?.elements) combinedElements.push(...parsed.body.elements)
      } else {
        const text = (JSON.parse(body.content) as { text?: string }).text || seg.plainTextMirror
        if (text) combinedElements.push({ tag: "markdown", content: escapeLarkMarkdown(text) })
      }
      continue
    }
    if (seg.type === "card" && isLarkCardPayload(seg.card.payload)) {
      const payload = seg.card.payload
      if (!header && isRecord(payload.header)) header = payload.header
      if (isRecord(payload.config)) {
        const oldStyle = isRecord(config?.style) ? config.style : {}
        const newStyle = isRecord(payload.config.style) ? payload.config.style : {}
        const style: Record<string, unknown> = { ...oldStyle, ...newStyle }
        for (const key of Object.keys(newStyle)) {
          if (isRecord(oldStyle[key]) && isRecord(newStyle[key]))
            style[key] = { ...oldStyle[key], ...newStyle[key] }
        }
        config = { ...config, ...payload.config, ...(Object.keys(style).length ? { style } : {}) }
      }
      if (
        payload.schema === "2.0" &&
        isRecord(payload.body) &&
        Array.isArray(payload.body.elements)
      ) {
        const { elements, ...layout } = payload.body
        bodyLayout = { ...bodyLayout, ...layout }
        combinedElements.push(...elements.filter(isRecord))
      } else {
        // Legacy/custom card dialects cannot be nested in Card 2.0. Keep a
        // readable full payload instead of silently losing the reply.
        combinedElements.push({
          tag: "markdown",
          content: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
        })
      }
      continue
    }
    if (seg.type === "text" || seg.type === "markdown") {
      const text = seg.type === "text" ? seg.text : seg.md
      if (!text) continue
      combinedElements.push({
        tag: "markdown",
        content: escapeLarkMarkdown(text),
      })
      continue
    }
    // Code blocks render as fenced lark_md — the raw code must NOT go
    // through escapeLarkMarkdown (a literal `@` or `\` inside code would
    // otherwise gain escapes).
    if (seg.type === "code") {
      const lang = seg.language ?? ""
      combinedElements.push({
        tag: "markdown",
        content: `\`\`\`${lang}\n${seg.code}\n\`\`\``,
      })
      continue
    }
    // Mentions inside a card use the lark_md at-syntax (`<at id=…></at>`),
    // which differs from the text-message `<at user_id=…>` syntax.
    if (seg.type === "mention") {
      combinedElements.push({
        tag: "markdown",
        content: `<at id=${seg.userId}></at>`,
      })
      continue
    }
    // Image segments whose upload pre-pass already resolved a Lark
    // image_key render as a real `img` element inside the combined card
    // instead of degrading to a `[image]` placeholder.
    if (seg.type === "image" && !seg.url.includes("://")) {
      combinedElements.push({
        tag: "img",
        img_key: seg.url,
        alt: { tag: "plain_text", content: seg.alt || "image" },
      })
      continue
    }
    // Other segments (file / voice / etc.): fall through to a textual
    // placeholder element — Lark cards can't host those media kinds
    // mid-card.
    combinedElements.push({
      tag: "markdown",
      content: `[${seg.type}]`,
    })
  }

  // The five-table limit applies to the combined message, not each surface.
  let tables = 0
  const elements = combinedElements.map((element) => {
    if (element.tag !== "table" || ++tables <= 5) return element
    return { tag: "markdown", content: JSON.stringify(element.rows) }
  })
  const card: Record<string, unknown> = {
    schema: "2.0",
    ...(config ? { config } : {}),
    body: { ...bodyLayout, elements: uniqueMergedElementIds(elements) },
  }
  if (header) card.header = header
  return {
    msg_type: "interactive",
    content: JSON.stringify(boundGeneratedCard(card)),
  }
}

/**
 * Convert a MessageSegment[] to a single LarkMessageBody.
 *
 * For multi-segment payloads we combine them into a single text/post body.
 * Segments that have no Lark representation are silently dropped.
 */
export function segmentsToLarkBody(segments: MessageSegment[]): LarkMessageBody {
  if (segments.length === 1) {
    const body = segmentToLarkBody(segments[0])
    if (body) return body
  }

  // Multi-segment or fallback: combine into a single text message where possible
  const textParts: string[] = []
  for (const seg of segments) {
    const body = segmentToLarkBody(seg)
    if (!body) continue

    if (body.msg_type === "text") {
      const parsed = JSON.parse(body.content) as { text?: string }
      if (parsed.text) textParts.push(parsed.text)
    } else {
      // For non-text types in a multi-segment, fall back to a plain label
      textParts.push(`[${seg.type}]`)
    }
  }

  const combined = textParts.join("\n")
  return {
    msg_type: "text",
    content: JSON.stringify({ text: combined || "[empty]" }),
  }
}
