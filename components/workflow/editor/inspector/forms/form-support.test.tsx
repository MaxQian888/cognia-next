import enForms from "@/i18n/messages/en/workflows/forms.json"
import zhForms from "@/i18n/messages/zh-CN/workflows/forms.json"
import { PLAN_STATUS_VALUES } from "@/lib/workflow/nodes/params-schemas"
import { clampNumberInput, parseArrayJson, parseObjectJson, PLAN_STATUSES } from "./form-support"

describe("workflow form support", () => {
  it("normalizes shared JSON and number inputs", () => {
    expect(parseObjectJson('{"ok":true}')).toEqual({ ok: true })
    expect(parseArrayJson("[1,2]")).toEqual([1, 2])
    expect(clampNumberInput("99", 0, 10, 5)).toBe(10)
  })
})

describe("PLAN_STATUSES", () => {
  it("is the schema's derived status list, so the terminal rejected status is offered", () => {
    expect(PLAN_STATUSES).toBe(PLAN_STATUS_VALUES)
    expect(PLAN_STATUSES).toContain("rejected")
  })

  it.each([
    ["en", enForms],
    ["zh-CN", zhForms],
  ])("%s labels every plan-list status option", (_locale, forms) => {
    const options = forms.planList.status.options as Record<string, string>
    expect(PLAN_STATUSES.filter((status) => !options[status])).toEqual([])
  })
})
