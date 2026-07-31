/** @jest-environment node */

/**
 * Smoke test for the quick-workflow-trigger dialog. The full render path
 * pulls in Dexie + TimezoneSelect + Radix Select internals; the heavy
 * machinery would push Jest workers over the heap limit (mirrors the
 * unified-task-detail-view test's smoke-only approach).
 */

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
jest.mock("@/lib/workflow/runtime/webhook-bridge", () => ({
  syncWorkflowTriggers: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../timezone-select", () => ({
  TimezoneSelect: () => null,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Top-level import (replaces require() — eslint forbids require-style).
import * as mod from "./quick-workflow-trigger-dialog"

describe("QuickWorkflowTriggerDialog module", () => {
  it("exports a function component named QuickWorkflowTriggerDialog", () => {
    expect(typeof mod.QuickWorkflowTriggerDialog).toBe("function")
  })

  it("persists the selected timezone on the canonical workflow trigger row", () => {
    expect(
      mod.createCronTriggerRow({
        triggerId: "trigger-1",
        workflowId: "workflow-1",
        cron: " 0 9 * * * ",
        timezone: "Asia/Shanghai",
        now: 123,
      })
    ).toEqual({
      id: "trigger-1",
      workflowId: "workflow-1",
      kind: "trigger.cron",
      enabled: true,
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      createdAt: 123,
      updatedAt: 123,
    })
  })
})
