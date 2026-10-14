import { resolveActivityI18n } from "./i18n"

describe("resolveActivityI18n", () => {
  it.each([
    ["en", "2m 23s", "2 tools · 1 failed", "Waiting for approval", "Denied", "Expired"],
    ["zh-CN", "用时 2分23秒", "2 个工具 · 1 个失败", "等待审批", "已拒绝", "已过期"],
  ])(
    "formats compact run summaries and approval states in %s",
    (locale, elapsed, tools, pending, denied, expired) => {
      const i18n = resolveActivityI18n(locale)
      expect(i18n.runElapsed(143)).toBe(elapsed)
      expect(i18n.toolSummary(2, 1)).toBe(tools)
      expect(i18n.approvalStatus("pending")).toBe(pending)
      expect(i18n.approvalStatus("denied")).toBe(denied)
      expect(i18n.approvalStatus("expired")).toBe(expired)
      expect(i18n.toolSummary(0, 0)).not.toContain(" · ")
    }
  )

  it("handles subminute, hour, zero and invalid elapsed values", () => {
    const en = resolveActivityI18n("en")
    expect(en.runElapsed(59.6)).toBe("1m")
    expect(en.runElapsed(3661)).toBe("1h 1m 1s")
    expect(en.runElapsed(-5)).toBe("0s")
    expect(en.runElapsed(Number.NaN)).toBe("0s")
  })
  it.each(["en", "zh-CN"])("localizes Lark timeline tags and headings in %s", (locale) => {
    const i18n = resolveActivityI18n(locale)
    expect(i18n.activityHeading(5)).toBe(locale === "en" ? "Activity · 5 steps" : "执行过程 · 5 步")
    expect(i18n.activityStatus("running")).toBe(locale === "en" ? "Running" : "进行中")
    expect(i18n.activityStatus("completed")).toBe(locale === "en" ? "Done" : "完成")
    expect(i18n.activityStatus("pending")).toBe(locale === "en" ? "Waiting" : "等待")
    expect(i18n.activityStatus("blocked")).toBe(locale === "en" ? "Waiting" : "等待")
    expect(i18n.activityStatus("failed")).toBe(locale === "en" ? "Failed" : "失败")
    expect(i18n.activityStatus("skipped")).toBe(locale === "en" ? "Skipped" : "跳过")
  })

  it("returns English for en", () => {
    const i18n = resolveActivityI18n("en")
    expect(i18n.working).toBe("Working")
    expect(i18n.done).toBe("Done")
    expect(i18n.tools(3)).toBe("3 tools")
    expect(i18n.tools(1)).toBe("1 tool")
    expect(i18n.edits(2)).toBe("2 edits")
    expect(i18n.elapsed(45)).toBe("45s")
  })

  it("returns Chinese for zh-CN", () => {
    const i18n = resolveActivityI18n("zh-CN")
    expect(i18n.working).toBe("处理中")
    expect(i18n.done).toBe("完成")
    expect(i18n.tools(3)).toBe("3 工具")
    expect(i18n.edits(1)).toBe("1 处编辑")
    expect(i18n.currentTool("bash")).toBe("当前：bash")
  })

  it("accepts zh / zh-Hans aliases", () => {
    expect(resolveActivityI18n("zh").working).toBe("处理中")
    expect(resolveActivityI18n("zh-Hans").working).toBe("处理中")
  })

  it("accepts en-US alias", () => {
    expect(resolveActivityI18n("en-US").working).toBe("Working")
  })

  it("falls back to English for an unknown locale", () => {
    expect(resolveActivityI18n("fr-FR").working).toBe("Working")
  })

  it("falls back to English for null/undefined", () => {
    expect(resolveActivityI18n(undefined).working).toBe("Working")
    expect(resolveActivityI18n(null).working).toBe("Working")
  })

  it("fileEdited interpolates path and counts", () => {
    expect(resolveActivityI18n("en").fileEdited("lib/x.ts", 12, 3)).toBe("lib/x.ts (+12 −3)")
    expect(resolveActivityI18n("zh-CN").fileEdited("lib/x.ts", 12, 3)).toBe("lib/x.ts（+12 −3）")
  })

  it("diffSkipped is defined for both locales", () => {
    expect(resolveActivityI18n("en").diffSkipped.length).toBeGreaterThan(0)
    expect(resolveActivityI18n("zh-CN").diffSkipped.length).toBeGreaterThan(0)
  })

  it("fileCreated / diffTruncated / diffExpandHint are defined for both locales", () => {
    for (const loc of ["en", "zh-CN"] as const) {
      const i18n = resolveActivityI18n(loc)
      expect(i18n.fileCreated("new.ts", 5).length).toBeGreaterThan(0)
      expect(i18n.diffTruncated(3).length).toBeGreaterThan(0)
      expect(i18n.diffExpandHint.length).toBeGreaterThan(0)
    }
  })

  it("appendLine / appendFinal render for both locales (append mode)", () => {
    for (const loc of ["en", "zh-CN"] as const) {
      const i18n = resolveActivityI18n(loc)
      expect(i18n.appendLine(2, 5, "bash").length).toBeGreaterThan(0)
      expect(i18n.appendLine(1, 1, null)).not.toContain("·")
      expect(i18n.appendFinal("done", 10).length).toBeGreaterThan(0)
      expect(i18n.appendFinal("failed", 10).length).toBeGreaterThan(0)
    }
  })

  it("provides localized durable-run timeline labels", () => {
    const en = resolveActivityI18n("en")
    const zh = resolveActivityI18n("zh-CN")

    expect(en.runStatus("running")).toBe("Working")
    expect(zh.runStatus("completed")).toBe("任务已完成")
    expect(en.runKind("workflow")).toBe("Workflow")
    expect(zh.runKind("scheduled")).toBe("定时任务")
    expect(
      zh.activityLabel({
        id: "lifecycle:done",
        kind: "lifecycle",
        category: "status",
        status: "completed",
        label: "Run completed",
        startedAt: 1,
      })
    ).toBe("任务已完成")
    expect(en.progress(2, 4, 50)).toBe("2/4 (50%)")
    expect(zh.completedActivities(3)).toBe("已完成 3 项")
    expect(en.omittedActivities(5)).toBe("… 5 earlier activities hidden")
  })

  it("provides the Lark COT strings for both locales", () => {
    const en = resolveActivityI18n("en")
    const zh = resolveActivityI18n("zh-CN")
    expect(en.cotToolFailed).toBe("Tool failed")
    expect(zh.cotToolFailed).toBe("执行失败")
    expect(en.cotWaitingForAction).toBe("Waiting for your action")
    expect(zh.cotWaitingForAction).toBe("等待你的操作")
    expect(en.cotProcessInline).toBe("Process shown in the thinking timeline above")
    expect(zh.cotProcessInline).toBe("执行过程见上方思维链")
  })
})
