import {
  buildLarkBindNoticeCard,
  buildLarkCommandFrame,
  buildLarkCommandReply,
  buildLarkStatusCard,
  chineseHalf,
} from "./command-cards"
import * as R from "@/lib/connectors/commands/render"

type Card = {
  header: Record<string, unknown> & { title: { content: string } }
  body: { elements: Array<Record<string, unknown>> }
}

const payload = (segment: ReturnType<typeof buildLarkCommandReply>): Card =>
  (segment as unknown as { card: { payload: Card } }).card.payload

describe("chineseHalf", () => {
  it("keeps the Chinese half of a real pair and of bracketed asides", () => {
    expect(chineseHalf("来源 / source")).toBe("来源")
    expect(chineseHalf("Adapter 默认 / adapter default")).toBe("Adapter 默认")
    expect(chineseHalf("deepseek（bot 默认 / bot default）")).toBe("deepseek（bot 默认）")
  })

  it("leaves text that is not one phrase twice unchanged", () => {
    expect(chineseHalf("会话 / session: 青松")).toBe("会话 / session: 青松")
    expect(chineseHalf("a / b")).toBe("a / b")
    expect(chineseHalf("deepseek-v4-flash")).toBe("deepseek-v4-flash")
  })
})

describe("buildLarkCommandReply", () => {
  it("preserves private-thread session guidance in command cards", () => {
    const card = payload(
      buildLarkCommandReply("new", R.confirmNewSession("Thread", "abc123", true), "applied")
    )
    const text = JSON.stringify(card.body)
    expect(text).toContain("当前话题")
    expect(text).toContain("Thread")
    expect(text).toContain("abc123")
    expect(text).toContain("每条新的顶层消息都会新建独立会话")
    const sessions = payload(
      buildLarkCommandReply(
        "sessions",
        R.renderSessions([{ title: "Legacy", idPrefix: "old123", active: false }], "chat"),
        "applied"
      )
    )
    expect(JSON.stringify(sessions.body)).toContain("本私聊的会话")
    expect(JSON.stringify(sessions.body)).toContain("Legacy")
  })

  it("reads the sessions list into a numbered list that tags the current one", () => {
    const card = payload(
      buildLarkCommandReply(
        "sessions",
        R.renderSessions([
          { title: "周报", idPrefix: "abc123", active: true },
          { title: "排期", idPrefix: "def456", active: false },
        ]),
        "applied"
      )
    )
    expect(card.header).toMatchObject({
      title: { content: "会话列表" },
      subtitle: { content: "/sessions" },
      icon: { token: "history_outlined" },
      template: "wathet",
    })
    const text = JSON.stringify(card.body)
    expect(text).toContain("**会话列表**")
    expect(text).toContain("1. 周报 &#40;abc123&#41; <text_tag color='blue'>当前</text_tag>")
    expect(text).not.toContain("active")
  })

  it("draws a command list as code-styled usage beside a grey description", () => {
    const card = payload(buildLarkCommandReply("commands", R.renderHelp(), "applied"))
    const rows = card.body.elements.find(
      (element) => typeof element.content === "string" && element.content.includes("`/status`")
    )
    expect(rows?.content).toContain("`/status`　<font color='grey'>查看当前会话设置</font>")
    expect(JSON.stringify(card.body)).not.toContain("show current settings")
  })

  it("turns bullet fields into tiles", () => {
    const card = payload(
      buildLarkCommandReply("dir", "• 目录 / dir: /work\n• 项目 / project: app", "applied")
    )
    expect(card.body.elements[0]).toMatchObject({ tag: "column_set", flex_mode: "bisect" })
    expect(JSON.stringify(card.body)).toContain("<font color='grey'>目录</font>")
  })

  it("leads an unknown command with a warning callout and keeps the hint", () => {
    const card = payload(buildLarkCommandReply("frob", R.renderUnknown("frob"), "unknown"))
    expect(card.header).toMatchObject({ title: { content: "未知命令" }, template: "orange" })
    expect(card.body.elements[0]).toMatchObject({
      tag: "column_set",
      background_style: "orange-50",
    })
    expect(JSON.stringify(card.body.elements[0])).toContain("未知命令：/frob")
    expect(JSON.stringify(card.body)).toContain("发送 /help 查看可用命令")
  })

  it("marks a write as done in green", () => {
    const card = payload(
      buildLarkCommandReply("new", "已新建会话 / New session started", "applied")
    )
    expect(card.header).toMatchObject({ title: { content: "新会话" }, template: "green" })
    expect(JSON.stringify(card.body)).toContain("已新建会话")
  })
})

describe("buildLarkCommandFrame", () => {
  it("puts an icon on the header by tone unless one is given", () => {
    expect(buildLarkCommandFrame("x", [], "warning")).toMatchObject({
      header: { template: "orange", icon: { token: "warning_outlined" } },
    })
    expect(buildLarkCommandFrame("x", [], "info", { icon: "robot_outlined" })).toMatchObject({
      header: { icon: { token: "robot_outlined" } },
    })
  })
})

describe("buildLarkStatusCard", () => {
  const view: R.StatusView = {
    behaviour: "assistant",
    mode: "auto",
    model: "deepseek-v4-flash（bot 默认 / bot default）",
    provider: "deepseek",
    character: "默认 / default",
    reasoning: "默认 / default",
    approvalMode: "prompt",
    team: "无 / none",
    workflow: "无 / none",
    routeSource: "Adapter 默认 / adapter default",
    matchedRule: "无 / none",
    responseAdapter: "lark-1（接收 Adapter / receiving adapter）",
    enabledRules: ["1. vip (r1) → team:t1"],
    sessionTitle: "飞书私聊",
    sessionIdPrefix: "abc123",
  }

  it("shows the settings as tiles and folds the routing away", () => {
    const card = payload(buildLarkStatusCard(view))
    expect(card.header).toMatchObject({
      title: { content: "会话状态" },
      subtitle: { content: "飞书私聊 · abc123" },
    })
    const text = JSON.stringify(card.body)
    expect(text).toContain("deepseek-v4-flash（bot 默认）")
    expect(text).toContain("<font color='grey'>团队</font>")
    expect(text).not.toContain("bot default")
    const panel = card.body.elements.find((element) => element.tag === "collapsible_panel")
    expect(panel).toMatchObject({ expanded: false })
    expect(JSON.stringify(panel)).toContain("1. vip &#40;r1&#41; → team:t1")
    expect(JSON.stringify(panel)).toContain("Adapter 默认")
  })
})

describe("buildLarkBindNoticeCard", () => {
  it("shows the code large, escaped, with what to do next", () => {
    const card = payload(buildLarkBindNoticeCard("fb_6c93eq9g"))
    expect(card.header).toMatchObject({ title: { content: "需要先关联账号" }, template: "orange" })
    const text = JSON.stringify(card.body)
    expect(text).toContain('"content":"**fb&#95;6c93eq9g**","text_size":"heading-2"')
    expect(text).toContain("请把下面的绑定码发给管理员")
    expect(text).toContain("Ask your administrator to approve bind code")
  })
})
