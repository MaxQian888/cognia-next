/** @jest-environment node */

import "fake-indexeddb/auto"
import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { PerformanceBudgetService } from "./budget-service"

function input() {
  return {
    id: "budget-a",
    name: "Main CPU",
    version: 1,
    metricId: "process.main.cpuPct",
    metricDefinitionVersion: 1,
    unit: "%",
    sourceKind: "host" as const,
    metricSchemaVersion: 1,
    requestedCadenceMs: 1000,
    aggregation: "p95" as const,
    direction: "lower" as const,
    warningThreshold: 60,
    failureThreshold: 80,
    applicability: {
      runtimeKinds: ["tauri-rust"] as const,
      buildProfiles: ["production"] as const,
    },
    comparisonWindow: "interval" as const,
    createdAt: 100,
  }
}

it("encrypts account-scoped immutable named budget profiles", async () => {
  const db = new CogniaAccountRegistryDB(`perf-budget-${crypto.randomUUID()}`)
  const service = new PerformanceBudgetService(db)
  const key = crypto.getRandomValues(new Uint8Array(32))
  const created = await service.create("account-a", key, input())
  expect(created).toMatchObject({ id: "budget-a", immutable: true, name: "Main CPU" })

  const row = await db.performanceBudgetProfiles.get("budget-a")
  expect(row).toMatchObject({ accountId: "account-a", version: 1 })
  expect(JSON.stringify(row)).not.toContain("Main CPU")
  expect(JSON.stringify(row)).not.toContain("process.main.cpuPct")
  await expect(service.create("account-a", key, input())).rejects.toThrow(
    "performance-budget-immutable"
  )
  expect(await service.list("account-a", key)).toEqual([created])
  expect(await service.get("account-b", key, "budget-a")).toBeNull()

  service.close()
  await db.delete()
})

it("rejects invalid threshold direction before writing", async () => {
  const db = new CogniaAccountRegistryDB(`perf-budget-invalid-${crypto.randomUUID()}`)
  const service = new PerformanceBudgetService(db)
  await expect(
    service.create("account-a", crypto.getRandomValues(new Uint8Array(32)), {
      ...input(),
      warningThreshold: 90,
      failureThreshold: 80,
    })
  ).rejects.toThrow("performance-budget-threshold-order-invalid")
  expect(await db.performanceBudgetProfiles.count()).toBe(0)
  service.close()
  await db.delete()
})
