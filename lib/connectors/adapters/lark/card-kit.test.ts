import {
  LARK_ICON,
  escapeLarkCardText,
  isCjkText,
  larkButton,
  larkButtonRow,
  larkCallout,
  larkCard,
  larkCardHeader,
  larkFieldGrid,
  larkNote,
  larkReplyLocale,
  larkToneTemplate,
} from "./card-kit"

describe("escapeLarkCardText", () => {
  it("writes every markdown and tag character as an HTML entity", () => {
    expect(escapeLarkCardText("*a* _b_ ~c~ `d` [e](f) #g $h !i |j \\k")).toBe(
      "&#42;a&#42; &#95;b&#95; &#126;c&#126; &#96;d&#96; &#91;e&#93;&#40;f&#41; &#35;g &#36;h &#33;i &#124;j &#92;k"
    )
    expect(escapeLarkCardText("<at id=all></at> & <font>")).toBe(
      "&#60;at id=all&#62;&#60;/at&#62; &#38; &#60;font&#62;"
    )
  })

  it("leaves @ and ordinary text alone", () => {
    expect(escapeLarkCardText("群聊中 @机器人 发起任务。")).toBe("群聊中 @机器人 发起任务。")
  })
})

describe("larkCardHeader", () => {
  it("carries an icon tinted by tone, a subtitle and at most three tags", () => {
    const header = larkCardHeader({
      title: "会话状态",
      subtitle: " /status ",
      icon: LARK_ICON.settings,
      tone: "info",
      tags: ["a", "b", "c", "d"].map((text) => ({ text, tone: "success" as const })),
    })
    expect(header).toMatchObject({
      title: { tag: "plain_text", content: "会话状态" },
      subtitle: { tag: "plain_text", content: "/status" },
      icon: { tag: "standard_icon", token: "setting-inter_filled", color: "blue" },
      template: "wathet",
    })
    expect(header.text_tag_list).toHaveLength(3)
    expect((header.text_tag_list as Array<{ color: string }>)[0].color).toBe("green")
  })

  it("omits an empty subtitle and the icon when none is given", () => {
    const header = larkCardHeader({ title: "x", subtitle: "  " })
    expect(header.subtitle).toBeUndefined()
    expect(header.icon).toBeUndefined()
  })

  it("maps each tone to its template", () => {
    expect(
      (["info", "success", "warning", "danger", "neutral"] as const).map(larkToneTemplate)
    ).toEqual(["wathet", "green", "orange", "red", "grey"])
  })
})

describe("larkCard", () => {
  it("is a shared Card 2.0 frame whose summary defaults to the title", () => {
    const card = larkCard({ header: { title: "新会话" }, elements: [] })
    expect(card).toMatchObject({
      schema: "2.0",
      config: { update_multi: true, summary: { content: "新会话" } },
      body: { padding: "12px 16px 16px 16px", vertical_spacing: "8px", elements: [] },
    })
  })
})

describe("larkFieldGrid", () => {
  it("puts two tiles to a row with a grey label over the value", () => {
    const rows = larkFieldGrid([
      { label: "模型", value: "deepseek" },
      { label: "提供商", value: "" },
      { label: "角色", value: "Cognia" },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ tag: "column_set", flex_mode: "bisect" })
    const [first, second] = (rows[0] as { columns: Array<Record<string, unknown>> }).columns
    expect(first).toMatchObject({ background_style: "grey-50" })
    expect((first.elements as Array<{ content: string }>)[0].content).toBe(
      "<font color='grey'>模型</font>"
    )
    // An empty value still shows something.
    expect((second.elements as Array<{ content: string }>)[1].content).toBe("—")
    expect((rows[1] as { columns: unknown[] }).columns).toHaveLength(1)
  })
})

describe("larkButton / larkButtonRow", () => {
  it("lays buttons out at their own width, left to right", () => {
    const stop = larkButton({
      text: "停止",
      type: "danger",
      icon: LARK_ICON.stop,
      behaviors: [{ type: "callback", value: {} }],
    })
    expect(stop).toMatchObject({
      tag: "button",
      type: "danger",
      size: "small",
      icon: { tag: "standard_icon", token: "stop_outlined" },
    })
    const row = larkButtonRow([stop, stop], { element_id: "run_actions" })
    expect(row).toMatchObject({ tag: "column_set", flex_mode: "flow", element_id: "run_actions" })
    expect((row.columns as Array<{ width: string }>).every((c) => c.width === "auto")).toBe(true)
  })
})

describe("larkCallout / larkNote", () => {
  it("tints a callout by tone and keeps notes grey notation", () => {
    expect(larkCallout("注意", "warning", LARK_ICON.warning)).toMatchObject({
      background_style: "orange-50",
    })
    expect(larkNote("提示")).toEqual({
      tag: "markdown",
      content: "<font color='grey'>提示</font>",
      text_size: "notation",
    })
  })
})

describe("larkReplyLocale", () => {
  it("answers in the language the person wrote in", () => {
    expect(isCjkText("17 乘 23 等于多少?")).toBe(true)
    expect(larkReplyLocale("17 乘 23 等于多少?", "en")).toBe("zh-CN")
    expect(larkReplyLocale("what is 17 times 23", "zh-CN")).toBe("en")
  })

  it("keeps the fallback when the text says nothing, Chinese without one", () => {
    expect(larkReplyLocale("17*23", "en")).toBe("en")
    expect(larkReplyLocale("17*23", undefined)).toBe("zh-CN")
    expect(larkReplyLocale(undefined, "")).toBe("zh-CN")
  })
})
