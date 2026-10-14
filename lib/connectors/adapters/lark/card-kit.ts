/**
 * The one visual vocabulary every Cognia Feishu card is drawn with.
 *
 * Feishu Card JSON 2.0 offers far more than a title and a block of markdown:
 * a header with an icon, a one-line subtitle and suffix tags; columns with
 * background colours; buttons with types, sizes and icons; a `notation` text
 * size. Cards built one by one each picked a little of that, so the bot's
 * command replies, run card, answer and notices looked like four products.
 * They draw from here instead.
 *
 * Every value is from the Card 2.0 reference (open.feishu.cn, "卡片 JSON 2.0
 * 结构", "标题", "分栏", "按钮", "富文本", icon and colour enumerations). An
 * icon token Feishu does not know can get a whole card refused, so the tokens
 * used are the named constants in {@link LARK_ICON}, each taken from the
 * published icon list.
 */

/** Header colour templates (标题主题样式). */
export type LarkHeaderTemplate =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "carmine"
  | "violet"
  | "purple"
  | "indigo"
  | "grey"
  | "default"

/** Standard icon tokens the cards use, all from Feishu's published icon list. */
export const LARK_ICON = {
  bot: "robot_outlined",
  info: "info_outlined",
  warning: "warning_outlined",
  error: "error_filled",
  success: "succeed_filled",
  waiting: "time_outlined",
  history: "history_outlined",
  settings: "setting-inter_filled",
  list: "list-check_outlined",
  folder: "folder_outlined",
  calendar: "calendar-chat_outlined",
  add: "add-chat_outlined",
  switch: "switch_outlined",
  member: "member_outlined",
  approval: "approval_outlined",
  safe: "safe_outlined",
  stop: "stop_outlined",
  pause: "pause_filled",
  resume: "play-round_filled",
  refresh: "refresh_outlined",
  edit: "edit_outlined",
  link: "sharelink_outlined",
  help: "helpdesk_outlined",
  code: "code_outlined",
  todo: "todo_outlined",
  tag: "tag_outlined",
  done: "done_outlined",
  close: "close_outlined",
  down: "down-small-ccm_outlined",
} as const

export type LarkIcon = (typeof LARK_ICON)[keyof typeof LARK_ICON]

export type LarkCardTone = "info" | "success" | "warning" | "danger" | "neutral"

/** What a tone looks like: header template, icon colour, callout background. */
const TONES: Record<
  LarkCardTone,
  { template: LarkHeaderTemplate; color: string; background: string }
> = {
  info: { template: "wathet", color: "blue", background: "blue-50" },
  success: { template: "green", color: "green", background: "green-50" },
  warning: { template: "orange", color: "orange", background: "orange-50" },
  danger: { template: "red", color: "red", background: "red-50" },
  neutral: { template: "grey", color: "grey", background: "grey-50" },
}

export function larkToneTemplate(tone: LarkCardTone): LarkHeaderTemplate {
  return TONES[tone].template
}

/**
 * Text placed inside a card `markdown` element, shown as typed.
 *
 * Card markdown has no backslash escapes: `\@` renders as a backslash and an
 * at sign. Its documented escape is the HTML entity (`&#42;` for `*`), so
 * every character the markdown or its tags (`<at>`, `<font>`) would read is
 * written that way. `@` is not among them: a card only mentions through an
 * `<at>` tag, which `<` escaping already disarms.
 */
export function escapeLarkCardText(text: string): string {
  return text.replace(/[&<>\\`*_~[\]()#$!|]/g, (char) => `&#${char.charCodeAt(0)};`)
}

export interface LarkCardHeaderInput {
  title: string
  subtitle?: string
  icon?: LarkIcon
  tone?: LarkCardTone
  /** At most three; Feishu drops the rest. */
  tags?: Array<{ text: string; tone?: LarkCardTone }>
}

/** A header: icon, a title (four lines at most), a one-line subtitle, tags. */
export function larkCardHeader(input: LarkCardHeaderInput): Record<string, unknown> {
  const tone = TONES[input.tone ?? "info"]
  return {
    title: { tag: "plain_text", content: input.title },
    ...(input.subtitle?.trim()
      ? { subtitle: { tag: "plain_text", content: input.subtitle.trim() } }
      : {}),
    ...(input.icon ? { icon: { tag: "standard_icon", token: input.icon, color: tone.color } } : {}),
    ...(input.tags?.length
      ? {
          text_tag_list: input.tags.slice(0, 3).map((tag) => ({
            tag: "text_tag",
            text: { tag: "plain_text", content: tag.text },
            color: tag.tone === "neutral" || !tag.tone ? "neutral" : TONES[tag.tone].color,
          })),
        }
      : {}),
    template: tone.template,
    padding: "12px 16px 12px 16px",
  }
}

/** Body spacing every Cognia card shares. */
export const LARK_CARD_BODY = {
  padding: "12px 16px 16px 16px",
  vertical_spacing: "8px",
} as const

export interface LarkCardInput {
  header?: LarkCardHeaderInput
  elements: Record<string, unknown>[]
  /** Chat-list and notification preview. Defaults to the title. */
  summary?: string
  widthMode?: "default" | "compact" | "fill"
}

/** A whole Card 2.0 payload in the shared frame. */
export function larkCard(input: LarkCardInput): Record<string, unknown> {
  const summary = input.summary ?? input.header?.title
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      ...(input.widthMode ? { width_mode: input.widthMode } : {}),
      ...(summary ? { summary: { content: summary } } : {}),
    },
    ...(input.header ? { header: larkCardHeader(input.header) } : {}),
    body: { ...LARK_CARD_BODY, elements: input.elements },
  }
}

/** Body text. `content` is markdown the caller has already escaped. */
export function larkMarkdown(content: string, extra: Record<string, unknown> = {}) {
  return { tag: "markdown", content, ...extra }
}

export interface LarkCollapsiblePanelInput {
  title: string
  expanded: boolean
  elements: Record<string, unknown>[]
  elementId?: string
}

/** A compact disclosure whose title is plain text and body accepts card elements. */
export function larkCollapsiblePanel(input: LarkCollapsiblePanelInput): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    ...(input.elementId ? { element_id: input.elementId } : {}),
    expanded: input.expanded,
    header: {
      title: { tag: "plain_text", content: input.title },
      icon: {
        tag: "standard_icon",
        token: LARK_ICON.down,
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    padding: "8px",
    vertical_spacing: "4px",
    elements: input.elements,
  }
}

const STATUS_TAG_COLORS = {
  running: "turquoise",
  completed: "green",
  failed: "red",
  blocked: "orange",
  waiting: "orange",
  pending: "neutral",
  skipped: "neutral",
} as const

/** A short status marker. `label` is raw text, escaped here for card markdown. */
export function larkStatusTag(status: keyof typeof STATUS_TAG_COLORS, label: string): string {
  return `<text_tag color='${STATUS_TAG_COLORS[status]}'>${escapeLarkCardText(label)}</text_tag>`
}

/** Quiet inline metadata. `text` is raw text, escaped here for card markdown. */
export function larkGreyText(text: string): string {
  return `<font color='grey'>${escapeLarkCardText(text)}</font>`
}

/** A small bold heading over a group, with an optional icon. */
export function larkSectionTitle(text: string, icon?: LarkIcon): Record<string, unknown> {
  return {
    tag: "markdown",
    content: `**${escapeLarkCardText(text)}**`,
    ...(icon ? { icon: { tag: "standard_icon", token: icon, color: "grey" } } : {}),
  }
}

/** One quiet grey line: hints, provenance, timings. `content` is escaped markdown. */
export function larkNote(content: string, extra: Record<string, unknown> = {}) {
  return {
    tag: "markdown",
    content: `<font color='grey'>${content}</font>`,
    text_size: "notation",
    ...extra,
  }
}

export interface LarkField {
  label: string
  /** Escaped markdown. */
  value: string
}

/**
 * Key-value pairs as light tiles, two to a row; a narrow screen stacks them.
 * Labels are grey notation, values body text.
 */
export function larkFieldGrid(fields: LarkField[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const pair = fields.slice(index, index + 2)
    rows.push({
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "8px",
      columns: pair.map((field) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        background_style: "grey-50",
        padding: "8px 12px 8px 12px",
        vertical_spacing: "2px",
        elements: [
          {
            tag: "markdown",
            content: `<font color='grey'>${escapeLarkCardText(field.label)}</font>`,
            text_size: "notation",
          },
          { tag: "markdown", content: field.value || "—" },
        ],
      })),
    })
  }
  return rows
}

/** A tinted block that says one important thing. `content` is escaped markdown. */
export function larkCallout(
  content: string,
  tone: LarkCardTone = "info",
  icon?: LarkIcon
): Record<string, unknown> {
  const style = TONES[tone]
  return {
    tag: "column_set",
    background_style: style.background,
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        padding: "10px 12px 10px 12px",
        elements: [
          {
            tag: "markdown",
            content,
            ...(icon ? { icon: { tag: "standard_icon", token: icon, color: style.color } } : {}),
          },
        ],
      },
    ],
  }
}

export interface LarkButtonInput {
  text: string
  /** Feishu button types. Filled for the one thing the card asks for. */
  type?:
    | "default"
    | "primary"
    | "danger"
    | "text"
    | "primary_text"
    | "danger_text"
    | "primary_filled"
    | "danger_filled"
  icon?: LarkIcon
  size?: "tiny" | "small" | "medium"
  behaviors: Record<string, unknown>[]
  extra?: Record<string, unknown>
}

export function larkButton(input: LarkButtonInput): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: input.text },
    type: input.type ?? "default",
    size: input.size ?? "small",
    ...(input.icon ? { icon: { tag: "standard_icon", token: input.icon } } : {}),
    behaviors: input.behaviors,
    ...(input.extra ?? {}),
  }
}

/**
 * Buttons side by side at their own width, left-aligned, wrapping on a
 * narrow screen; never stretched into equal columns with gaps between.
 */
export function larkButtonRow(
  buttons: Record<string, unknown>[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    ...extra,
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [button],
    })),
  }
}

/** Whether a text is mostly written in Chinese, Japanese or Korean script. */
export function isCjkText(text: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯豈-﫿]/.test(text)
}

/**
 * The language a card answers a person in: the language they wrote in when
 * the text shows it, else `fallback`. A card follows the person in the chat,
 * not the host's own UI language; a message with no words at all ("17*23")
 * says nothing and keeps the fallback.
 */
export function larkReplyLocale(text: string | undefined, fallback: string | undefined): string {
  if (text && isCjkText(text)) return "zh-CN"
  if (text && /[A-Za-z]{3,}/.test(text)) return "en"
  return fallback || "zh-CN"
}
