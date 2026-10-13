/**
 * Cards for in-chat command replies, help/welcome and closed approval cards,
 * drawn with the shared kit (`card-kit.ts`).
 *
 * The replies themselves are written once for every platform as bilingual
 * text (`commands/render.ts`: "来源 / source: …"). On Feishu that text is
 * read back into structure rather than shown as lines: a heading ending in a
 * colon becomes a section title, `• label: value` lines become tiles, a
 * command list becomes code-styled rows, a numbered list keeps its order and
 * marks the current entry. The bot runs on the Chinese Feishu
 * (`open.feishu.cn`), and a bare `/status` says nothing about its sender's
 * language, so labels and headings show their Chinese half; values keep what
 * the reply wrote.
 */

import type { MessageSegment } from "@/types/connectors/segment"
import type { ControlCommandName } from "@/lib/connectors/commands/registry"
import type { StatusView } from "@/lib/connectors/commands/render"
import {
  LARK_ICON,
  escapeLarkCardText,
  larkCallout,
  larkCard,
  larkFieldGrid,
  larkMarkdown,
  larkNote,
  larkSectionTitle,
  type LarkCardTone,
  type LarkField,
  type LarkIcon,
} from "./card-kit"

/** The header each command's reply carries. */
const COMMAND_HEADERS: Record<ControlCommandName, { title: string; icon: LarkIcon }> = {
  help: { title: "帮助", icon: LARK_ICON.help },
  commands: { title: "全部命令", icon: LARK_ICON.list },
  status: { title: "会话状态", icon: LARK_ICON.settings },
  sessions: { title: "会话列表", icon: LARK_ICON.history },
  dir: { title: "工作目录", icon: LARK_ICON.folder },
  new: { title: "新会话", icon: LARK_ICON.add },
  switch: { title: "切换会话", icon: LARK_ICON.switch },
  resume: { title: "恢复会话", icon: LARK_ICON.history },
  mode: { title: "行为模式", icon: LARK_ICON.settings },
  model: { title: "模型", icon: LARK_ICON.bot },
  reasoning: { title: "思考强度", icon: LARK_ICON.settings },
  character: { title: "角色", icon: LARK_ICON.member },
  team: { title: "Agent 团队", icon: LARK_ICON.member },
  workflow: { title: "工作流", icon: LARK_ICON.list },
  agent: { title: "话题 Agent", icon: LARK_ICON.bot },
  goal: { title: "目标", icon: LARK_ICON.todo },
  tasks: { title: "定时任务", icon: LARK_ICON.calendar },
  schedule: { title: "定时任务", icon: LARK_ICON.calendar },
  handoff: { title: "转交给人", icon: LARK_ICON.member },
  delegate: { title: "委派", icon: LARK_ICON.switch },
}

const READ_COMMANDS = new Set(["commands", "status", "sessions", "dir", "tasks", "agent"])

/**
 * The Chinese half of a bilingual "中文 / English" phrase, and of every
 * bracketed "（中文 / English）" aside inside one. A phrase that is not
 * bilingual comes back unchanged.
 */
export function chineseHalf(text: string): string {
  const asides = text.replace(/（([^（）/]+?) \/ [^（）]+?）/g, "（$1）")
  // A real pair splits at a " / " with Chinese before it and none after;
  // anything else ("会话 / session: 青松") is not one phrase twice.
  const cjk = /[㐀-鿿]/
  for (let at = asides.indexOf(" / "); at > 0; at = asides.indexOf(" / ", at + 1)) {
    const before = asides.slice(0, at).trim()
    const after = asides.slice(at + 3).trim()
    if (after && cjk.test(before) && !cjk.test(after)) return before
  }
  return asides
}

/** The shared frame: help/welcome surfaces and closed approval cards use it too. */
export function buildLarkCommandFrame(
  title: string,
  elements: Record<string, unknown>[],
  tone: "info" | "success" | "warning" = "info",
  options: { icon?: LarkIcon; subtitle?: string } = {}
): Record<string, unknown> {
  return larkCard({
    header: {
      title,
      tone,
      icon:
        options.icon ??
        (tone === "warning"
          ? LARK_ICON.warning
          : tone === "success"
            ? LARK_ICON.success
            : undefined),
      ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    },
    elements,
  })
}

type Block =
  | { kind: "title"; text: string }
  | { kind: "fields"; fields: LarkField[] }
  | { kind: "commands"; rows: Array<{ usage: string; desc: string }> }
  | { kind: "list"; rows: Array<{ text: string; current: boolean }> }
  | { kind: "text"; lines: string[] }

/** `• label: value`, or a bare `中文 / english: value` (a bare one needs a value). */
const FIELD_LINE =
  /^(?:[•·-]\s+([^:：]{1,60})[:：]\s*(.*)|([^:：/]{1,30} \/ [^:：]{1,40})[:：]\s*(\S.*))$/
const COMMAND_LINE = /^(?:[•·-]\s+)?(\/[^\s—]+(?:\s+[^—]*?)?)\s+—\s+(.*)$/
const LIST_LINE = /^(\d+)\.\s+(.*)$/
const CURRENT_MARK = /\s*←\s*当前(?:\s*\/\s*active)?\s*$/

function parseReply(text: string): Block[] {
  const blocks: Block[] = []
  const last = () => blocks[blocks.length - 1]
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const command = line.match(COMMAND_LINE)
    if (command) {
      const previous = last()
      const row = { usage: command[1].trim(), desc: chineseHalf(command[2].trim()) }
      if (previous?.kind === "commands") previous.rows.push(row)
      else blocks.push({ kind: "commands", rows: [row] })
      continue
    }
    const field = line.match(FIELD_LINE)
    if (field) {
      const previous = last()
      const entry = {
        label: chineseHalf((field[1] ?? field[3]).trim()),
        value: escapeLarkCardText(chineseHalf((field[2] ?? field[4]).trim())),
      }
      if (previous?.kind === "fields") previous.fields.push(entry)
      else blocks.push({ kind: "fields", fields: [entry] })
      continue
    }
    const item = line.match(LIST_LINE)
    if (item) {
      const previous = last()
      const current = CURRENT_MARK.test(item[2])
      const row = { text: `${item[1]}. ${item[2].replace(CURRENT_MARK, "")}`, current }
      if (previous?.kind === "list") previous.rows.push(row)
      else blocks.push({ kind: "list", rows: [row] })
      continue
    }
    if (/[:：]$/.test(line) && line.length <= 80) {
      blocks.push({ kind: "title", text: chineseHalf(line.slice(0, -1).trim()) })
      continue
    }
    const previous = last()
    const paragraph = chineseHalf(line.replace(/^[•·-]\s+/, ""))
    if (previous?.kind === "text") previous.lines.push(paragraph)
    else blocks.push({ kind: "text", lines: [paragraph] })
  }
  return blocks
}

function renderBlocks(blocks: Block[]): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case "title":
        elements.push(larkSectionTitle(block.text))
        break
      case "fields":
        elements.push(...larkFieldGrid(block.fields))
        break
      case "commands":
        // Eight rows to an element keeps a long list well inside the
        // 200-component ceiling without merging every row into one block.
        for (let index = 0; index < block.rows.length; index += 8) {
          elements.push(
            larkMarkdown(
              block.rows
                .slice(index, index + 8)
                .map(
                  (row) =>
                    `\`${row.usage.replace(/`/g, "'")}\`　<font color='grey'>${escapeLarkCardText(row.desc)}</font>`
                )
                .join("\n")
            )
          )
        }
        break
      case "list":
        elements.push(
          larkMarkdown(
            block.rows
              .map(
                (row) =>
                  `${escapeLarkCardText(row.text)}${row.current ? " <text_tag color='blue'>当前</text_tag>" : ""}`
              )
              .join("\n")
          )
        )
        break
      case "text":
        elements.push(larkMarkdown(block.lines.map(escapeLarkCardText).join("\n")))
        break
    }
  }
  return elements
}

/** A command reply: the command's header over its text, read back into structure. */
export function buildLarkCommandReply(
  command: string,
  text: string,
  outcome: "applied" | "denied" | "unknown"
): MessageSegment {
  const known = COMMAND_HEADERS[command as ControlCommandName]
  const tone: LarkCardTone =
    outcome !== "applied" ? "warning" : READ_COMMANDS.has(command) ? "info" : "success"
  const title =
    outcome === "unknown" ? "未知命令" : outcome === "denied" ? "未执行" : (known?.title ?? "命令")
  const icon =
    outcome === "applied"
      ? (known?.icon ?? LARK_ICON.info)
      : outcome === "denied"
        ? LARK_ICON.safe
        : LARK_ICON.warning
  let elements: Record<string, unknown>[]
  if (outcome === "applied") {
    elements = renderBlocks(parseReply(text))
  } else {
    // The first line says what happened, as one tinted line; the rest is the
    // hint. The unknown command's own line names a value in its English
    // half, so its lead is written here instead.
    const [first = "", ...rest] = text.split("\n")
    const lead =
      outcome === "unknown"
        ? `未知命令：/${command}`
        : chineseHalf(first.trim()) || "你没有权限在此会话执行该命令"
    elements = [
      larkCallout(escapeLarkCardText(lead), "warning", LARK_ICON.warning),
      ...renderBlocks(parseReply(rest.join("\n"))),
    ]
  }
  if (elements.length > 60) elements = [larkMarkdown(escapeLarkCardText(text))]
  return {
    type: "card",
    card: {
      kind: "lark",
      payload: larkCard({
        header: { title, subtitle: `/${command}`, icon, tone },
        elements: elements.length ? elements : [larkMarkdown("—")],
        summary: `${title} · /${command}`,
      }),
    },
  }
}

/**
 * `/status` from its structured view: what answers in this chat up front as
 * tiles, the routing that decided it folded away below.
 */
export function buildLarkStatusCard(view: StatusView): MessageSegment {
  const value = (text: string) => escapeLarkCardText(chineseHalf(text || "—"))
  const primary: LarkField[] = [
    { label: "行为", value: value(view.behaviour) },
    { label: "模型", value: value(view.model) },
    { label: "提供商", value: value(view.provider) },
    { label: "思考强度", value: value(view.reasoning) },
    { label: "审批", value: value(view.approvalMode) },
    { label: "角色", value: value(view.character) },
    ...(view.assignee ? [{ label: "分配", value: value(view.assignee) }] : []),
    { label: "团队", value: value(view.team) },
    { label: "工作流", value: value(view.workflow) },
  ]
  const route: LarkField[] = [
    { label: "来源", value: value(view.routeSource) },
    { label: "匹配规则", value: value(view.matchedRule) },
    { label: "回复 Adapter", value: value(view.responseAdapter) },
    { label: "兼容模式", value: value(view.mode) },
  ]
  const rules = view.enabledRules.length
    ? view.enabledRules.map((rule) => escapeLarkCardText(rule)).join("\n")
    : "无"
  return {
    type: "card",
    card: {
      kind: "lark",
      payload: larkCard({
        header: {
          title: "会话状态",
          subtitle: `${view.sessionTitle} · ${view.sessionIdPrefix}`,
          icon: LARK_ICON.settings,
          tone: "info",
        },
        summary: `会话状态 · ${view.model}`,
        elements: [
          ...larkFieldGrid(primary),
          {
            tag: "collapsible_panel",
            expanded: false,
            header: {
              title: { tag: "markdown", content: "**路由与规则**" },
              background_color: "grey-50",
              padding: "8px 12px 8px 12px",
              icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
              icon_position: "right",
              icon_expanded_angle: -180,
            },
            border: { color: "grey-100", corner_radius: "6px" },
            padding: "8px 12px 12px 12px",
            vertical_spacing: "8px",
            elements: [
              ...larkFieldGrid(route),
              larkSectionTitle("已启用规则（按优先级）"),
              larkMarkdown(rules),
            ],
          },
          larkNote("后续消息会按其文本、发送者和频道重新匹配，路由可能不同。"),
        ],
      }),
    },
  }
}

/**
 * Told to someone the bot does not know yet: the bind code an administrator
 * approves, large enough to read out, with the one thing to do next.
 */
export function buildLarkBindNoticeCard(bindCode: string): MessageSegment {
  const code = escapeLarkCardText(bindCode)
  return {
    type: "card",
    card: {
      kind: "lark",
      payload: larkCard({
        header: {
          title: "需要先关联账号",
          subtitle: "Cognia 还不认识这个飞书账号",
          icon: LARK_ICON.safe,
          tone: "warning",
        },
        summary: `需要先关联账号 · 绑定码 ${bindCode}`,
        elements: [
          larkMarkdown("请把下面的绑定码发给管理员，审批通过后即可开始对话。"),
          {
            tag: "column_set",
            background_style: "grey-50",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                padding: "12px 16px 12px 16px",
                vertical_spacing: "2px",
                elements: [
                  larkNote("绑定码"),
                  { tag: "markdown", content: `**${code}**`, text_size: "heading-2" },
                ],
              },
            ],
          },
          larkNote(
            `This Feishu account is not linked to Cognia yet. Ask your administrator to approve bind code ${code}.`
          ),
        ],
      }),
    },
  }
}
