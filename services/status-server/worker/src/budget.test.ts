import { describe, expect, it } from "vitest"
import { FakeRelay } from "../../probe/src/testing/fake-relay"
import { currentMinute, minuteMs, resetCore, seedRegistry, testEnv } from "../test/helpers"
import { runScheduled } from "./cron"
import { cronModules } from "./modules"

function counting(db: D1Database) {
  const stats = { prepared: 0, batches: 0, batchStatements: 0, single: 0 }
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind")
          return (...args: unknown[]) =>
            wrapStmt((target.bind as (...a: unknown[]) => D1PreparedStatement)(...args))
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => {
            stats.single += 1
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          stats.prepared += 1
          return wrapStmt(target.prepare(sql))
        }
      if (prop === "batch")
        return (statements: D1PreparedStatement[]) => {
          stats.batches += 1
          stats.batchStatements += statements.length
          return target.batch(statements as never)
        }
      const value = Reflect.get(target, prop)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { db: proxy as D1Database, stats }
}

/**
 * D1 counts every statement against the per-invocation query limit (1000 on
 * Workers Paid). One Cron minute must stay far below it; this guard fails if
 * a change makes the minute's query count grow without bound.
 */
export const CRON_MINUTE_STATEMENT_BUDGET = 150

describe("Cron minute D1 budget", () => {
  it("stays within the per-invocation statement budget, including the hourly retention minute", async () => {
    await resetCore()
    const minute = currentMinute() - (currentMinute() % 5)
    await seedRegistry(
      [
        {
          id: "cf-cron",
          source: "cloudflare",
          enrolledAtMs: minuteMs(minute - 10),
          profiles: [
            { id: "native", http: 60, protocol: 60 },
            { id: "web", http: null, protocol: 300 },
            { id: "ios", http: null, protocol: 300 },
            { id: "android", http: null, protocol: 300 },
          ],
        },
      ],
      [{ probeId: "cf-cron", effectiveMinute: minute - 10 }]
    )
    for (const offset of [0, 1, 17 - (minute % 60) + 60]) {
      const { db, stats } = counting(testEnv.DB)
      const t = minuteMs(minute + offset)
      const started = performance.now()
      await runScheduled({ ...testEnv, DB: db }, t, cronModules, {
        transport: new FakeRelay(),
        now: () => t + 1000,
      })
      const total = stats.single + stats.batchStatements
      expect(
        total,
        JSON.stringify({ offset, ...stats, ms: Math.round(performance.now() - started) })
      ).toBeLessThan(CRON_MINUTE_STATEMENT_BUDGET)
    }
  })
})
