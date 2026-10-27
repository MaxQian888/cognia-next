import data from "./builtin-tools-data.json"
import en from "@/i18n/messages/en/toolSettings.json"
import zh from "@/i18n/messages/zh-CN/toolSettings.json"

it("keeps verification batches approval-gated, mutating and deferred in both locales", () => {
  const tool = data.categories
    .flatMap((category) => category.tools)
    .find((entry) => entry.name === "verification_batch")
  expect(tool).toMatchObject({ riskLevel: "high", requiresApproval: true, alwaysLoad: false })
  expect(tool).not.toHaveProperty("programmaticReadOnly", true)
  expect(en.tools.verificationBatch).toBeTruthy()
  expect(zh.tools.verificationBatch).toBeTruthy()
})
