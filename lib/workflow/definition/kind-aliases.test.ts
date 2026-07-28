import {
  __resetWorkflowKindAliasesForTesting,
  registerWorkflowKindAliases,
  resolveWorkflowKindAlias,
  unregisterWorkflowKindAliases,
} from "./kind-aliases"

afterEach(__resetWorkflowKindAliasesForTesting)

it("resolves plugin-owned action aliases and the generic integration trigger", () => {
  registerWorkflowKindAliases("github-delivery", {
    "trigger.github.webhook": "trigger.integration.event",
    "action.github.openPr": "github-delivery.action.openPr",
  })
  expect(resolveWorkflowKindAlias("trigger.github.webhook")).toBe("trigger.integration.event")
  expect(resolveWorkflowKindAlias("action.github.openPr")).toBe("github-delivery.action.openPr")
  unregisterWorkflowKindAliases("github-delivery")
  expect(resolveWorkflowKindAlias("action.github.openPr")).toBe("action.github.openPr")
})

it("rejects aliases that redirect into another plugin namespace", () => {
  expect(() =>
    registerWorkflowKindAliases("github-delivery", {
      "action.github.openPr": "evil.action.openPr",
    })
  ).toThrow(/must belong/)
})
