/**
 * @jest-environment node
 */
import { installWriteFlush, type DexieLike } from "./write-flush"

describe("installWriteFlush", () => {
  it("schedules a flush after every settled mutation, not on failures", async () => {
    const writes: string[] = []
    let middleware: {
      create(down: unknown): { table(name: string): { mutate(req: unknown): Promise<unknown> } }
    } | null = null
    const fakeDb: DexieLike = {
      use(mw) {
        middleware = mw as typeof middleware
        return fakeDb
      },
    }
    installWriteFlush(fakeDb, (tableName) => writes.push(tableName))
    expect(middleware).not.toBeNull()

    const down = {
      table: (name: string) => ({
        mutate: (req: unknown) =>
          name === "boom" ? Promise.reject(new Error("nope")) : Promise.resolve({ req }),
      }),
    }
    const core = middleware!.create(down)

    await core.table("sessions").mutate({ type: "put" })
    await core.table("messages").mutate({ type: "delete" })
    await core
      .table("boom")
      .mutate({ type: "put" })
      .catch(() => undefined)
    // onWrite runs on the settled promise's microtask.
    await new Promise((r) => setTimeout(r, 0))
    expect(writes).toEqual(["sessions", "messages"])
  })

  // Excluded tables are not in the snapshot, so their writes must not drive a
  // re-dump either — otherwise `executions` (append-heavy) would keep flushing a
  // file that contains none of its rows.
  it("does not schedule a flush for ignored tables", async () => {
    const writes: string[] = []
    let middleware: {
      create(down: unknown): { table(name: string): { mutate(req: unknown): Promise<unknown> } }
    } | null = null
    const fakeDb: DexieLike = {
      use(mw) {
        middleware = mw as typeof middleware
        return fakeDb
      },
    }
    installWriteFlush(fakeDb, (tableName) => writes.push(tableName), {
      ignoreTables: ["executions"],
    })

    const core = middleware!.create({
      table: () => ({ mutate: (req: unknown) => Promise.resolve({ req }) }),
    })
    await core.table("executions").mutate({ type: "put" })
    await core.table("tasks").mutate({ type: "put" })
    await new Promise((r) => setTimeout(r, 0))
    expect(writes).toEqual(["tasks"])
  })
})
