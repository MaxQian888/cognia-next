import { isDingtalkJsonShape, isDingtalkTextShape, parseDingtalkExport } from "./dingtalk"

describe("parseDingtalkExport", () => {
  it("parses the bracket-header text format", () => {
    const text = [
      "[2024-03-01 10:00:00] 张三",
      "今天的发布按计划",
      "已经提交 PR",
      "",
      "[2024-03-01 10:01:00] 李四",
      "我去 review",
    ].join("\n")
    const sources = parseDingtalkExport(text, { twinId: "t_a" })
    expect(sources).toHaveLength(1)
    const body = sources[0].text
    expect(body).toContain("### 张三")
    expect(body).toContain("已经提交 PR")
    expect(body).toContain("### 李四")
    expect(sources[0].baseMetadata?.speakers).toEqual(["张三", "李四"])
    expect(sources[0].baseMetadata?.platform).toBe("dingtalk")
  })

  it("parses the JSON export shape", () => {
    const sources = parseDingtalkExport(
      JSON.stringify({
        groupName: "项目沟通",
        messages: [
          {
            senderName: "王五",
            sendTime: "2024-03-01 10:00:00",
            content: "周五请客户做演示",
            type: "text",
          },
          {
            senderName: "赵六",
            sendTime: "2024-03-01 10:05:00",
            content: "演示稿我准备好了",
            type: "text",
          },
        ],
      }),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("演示稿我准备好了")
    expect(sources[0].filename).toContain("项目沟通")
  })

  it("falls back to bracket-text when JSON.parse fails", () => {
    const text = "[2024-03-01 10:00:00] 张三\n你好"
    const sources = parseDingtalkExport(text, { twinId: "t1" })
    expect(sources[0].text).toContain("你好")
  })

  it("detects text vs JSON shapes", () => {
    expect(isDingtalkTextShape("[2024-03-01 10:00:00] 张三\n你好")).toBe(true)
    expect(isDingtalkTextShape("just text")).toBe(false)
    expect(
      isDingtalkJsonShape({
        messages: [{ senderName: "X", sendTime: "2024-03-01 10:00:00" }],
      })
    ).toBe(true)
    expect(isDingtalkJsonShape({ messages: [{}] })).toBe(false)
    expect(isDingtalkJsonShape(null)).toBe(false)
  })
})
