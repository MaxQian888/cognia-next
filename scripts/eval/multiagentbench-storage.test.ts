/** @jest-environment node */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BenchmarkStorage } from "./multiagentbench-storage"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mab-storage-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
const policy = { minFreeBytes: 0, reserveBytes: 4096, pollMs: 1 }

it("keeps the previous atomic snapshot on a failed rename", async () => {
  const store = await BenchmarkStorage.open(dir, policy, {
    rename: async (from, to) => {
      if (String(to).endsWith("results.json")) throw Error("snapshot fault")
      return fs.rename(from, to)
    },
  })
  try {
    await fs.writeFile(path.join(dir, "results.json"), "old")
    await expect(store.snapshot("new")).rejects.toThrow("snapshot fault")
    expect(await fs.readFile(path.join(dir, "results.json"), "utf8")).toBe("old")
  } finally {
    await store.close()
  }
  expect(
    (await fs.readdir(dir)).filter((name) => name.includes(".next") || name.includes("lock"))
  ).toEqual([])
})

it("rolls back a partial append, releases its reserve and retries exactly once", async () => {
  let failed = false
  const store = await BenchmarkStorage.open(dir, policy, {
    appendFile: async (file, data) => {
      if (!failed) {
        failed = true
        await fs.appendFile(file, String(data).slice(0, 8))
        throw Object.assign(Error("full"), { code: "ENOSPC" })
      }
      return fs.appendFile(file, data)
    },
  })
  try {
    await store.waitForSpace(new AbortController().signal)
    await store.append({ state: "admitted", callId: "call-1" })
    expect(await store.replay()).toEqual([{ state: "admitted", callId: "call-1" }])
    await expect(fs.access(path.join(dir, ".emergency-reserve"))).rejects.toThrow()
  } finally {
    await store.close()
  }
})

it("preserves a torn tail separately and resumes only whole journal records", async () => {
  await fs.writeFile(path.join(dir, "events.ndjson"), '{"callId":"kept"}\n{"callId":"torn')
  const store = await BenchmarkStorage.open(dir, policy)
  try {
    expect(await store.replay()).toEqual([{ callId: "kept" }])
    await store.append({ callId: "next" })
    expect(await store.replay()).toEqual([{ callId: "kept" }, { callId: "next" }])
    const tail = (await fs.readdir(dir)).find((name) => name.startsWith("journal-tail-"))!
    expect(await fs.readFile(path.join(dir, tail), "utf8")).toBe('{"callId":"torn')
  } finally {
    await store.close()
  }
})

it("refuses a second live writer and releases the lock and reserve on close", async () => {
  const store = await BenchmarkStorage.open(dir, policy)
  try {
    await store.waitForSpace(new AbortController().signal)
    await expect(BenchmarkStorage.open(dir, policy)).rejects.toThrow(/active writer/)
  } finally {
    await store.close()
  }
  expect(await fs.readdir(dir)).toEqual([])
  const next = await BenchmarkStorage.open(dir, policy)
  await next.close()
})

it("cancels disk waiting without admitting work or retaining a reserve", async () => {
  const store = await BenchmarkStorage.open(dir, {
    ...policy,
    minFreeBytes: Number.MAX_SAFE_INTEGER,
  })
  const controller = new AbortController()
  const waiting = store.waitForSpace(controller.signal)
  controller.abort()
  expect(await waiting).toBe(false)
  await store.close()
  expect(await fs.readdir(dir)).toEqual([])
})

it("reclaims only a verified dead owner's nonce and refuses corrupt interior records", async () => {
  const lock = path.join(dir, ".runner-lock")
  await fs.mkdir(lock)
  await fs.writeFile(
    path.join(lock, "dead-nonce.json"),
    JSON.stringify({ pid: 2147483647, host: os.hostname() })
  )
  const store = await BenchmarkStorage.open(dir, policy)
  try {
    await fs.writeFile(path.join(dir, "events.ndjson"), '{"kept":true}\nnot JSON\n')
    await expect(store.replay()).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, "events.ndjson"), "utf8")).toContain("not JSON")
  } finally {
    await store.close()
  }
})

it("latches a persistent evidence failure and refuses queued future admissions", async () => {
  let appends = 0
  const store = await BenchmarkStorage.open(dir, policy, {
    appendFile: async () => {
      appends++
      throw Object.assign(Error("still full"), { code: "ENOSPC" })
    },
  })
  try {
    await store.waitForSpace(new AbortController().signal)
    const first = store.append({ callId: "not-dispatched" })
    const second = store.append({ callId: "also-refused" })
    const results = await Promise.allSettled([first, second])
    expect(results.every((row) => row.status === "rejected")).toBe(true)
    expect(appends).toBe(2) // initial attempt plus one emergency retry, no second admission write
    expect(await store.replay()).toEqual([])
  } finally {
    await store.close()
  }
})

it("latches stat failure before a queued second admission can write", async () => {
  let reads = 0
  const store = await BenchmarkStorage.open(dir, policy, {
    stat: (async (file: Parameters<typeof fs.stat>[0]) => {
      if (++reads === 1) throw Object.assign(Error("stat EIO"), { code: "EIO" })
      return fs.stat(file)
    }) as typeof fs.stat,
  })
  try {
    const results = await Promise.allSettled([store.append({ id: 1 }), store.append({ id: 2 })])
    expect(results.map((row) => row.status)).toEqual(["rejected", "rejected"])
    await expect(store.waitForSpace(new AbortController().signal)).rejects.toThrow("stat EIO")
    expect(await store.replay()).toEqual([])
  } finally {
    await store.close()
  }
})

it("rejects invalid interior UTF-8 before changing any journal bytes", async () => {
  const bytes = Buffer.concat([
    Buffer.from('{"id":"'),
    Buffer.from([255]),
    Buffer.from('"}\n{"tail"'),
  ])
  await fs.writeFile(path.join(dir, "events.ndjson"), bytes)
  const store = await BenchmarkStorage.open(dir, policy)
  try {
    await expect(store.replay()).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, "events.ndjson"))).toEqual(bytes)
    expect((await fs.readdir(dir)).some((name) => name.startsWith("journal-tail"))).toBe(false)
  } finally {
    await store.close()
  }
})

it("validates complete records before rolling back a torn tail", async () => {
  const bytes = Buffer.from('{"id":"invalid-semantic"}\n{"tail"')
  await fs.writeFile(path.join(dir, "events.ndjson"), bytes)
  const store = await BenchmarkStorage.open(dir, policy)
  try {
    await expect(
      store.replay(() => {
        throw Error("invalid semantic record")
      })
    ).rejects.toThrow("invalid semantic record")
    expect(await fs.readFile(path.join(dir, "events.ndjson"))).toEqual(bytes)
  } finally {
    await store.close()
  }
})

it("makes close terminal even when cleanup fails and never changes a successor's reserve", async () => {
  let fail = true
  const first = await BenchmarkStorage.open(dir, policy, {
    rm: async (file, options) => {
      if (String(file).endsWith(".emergency-reserve") && fail) {
        fail = false
        throw Error("cleanup EIO")
      }
      return fs.rm(file, options)
    },
  })
  await first.waitForSpace(new AbortController().signal)
  await expect(first.close()).rejects.toThrow("cleanup")
  const second = await BenchmarkStorage.open(dir, policy)
  try {
    await second.waitForSpace(new AbortController().signal)
    await expect(first.close()).rejects.toThrow("cleanup")
    await expect(first.append({ stale: true })).rejects.toThrow(/closed/)
    await expect(first.snapshot("stale")).rejects.toThrow(/closed/)
    await expect(first.replay()).rejects.toThrow(/closed/)
    await expect(first.waitForSpace(new AbortController().signal)).rejects.toThrow(/closed/)
    expect((await fs.stat(path.join(dir, ".emergency-reserve"))).size).toBe(policy.reserveBytes)
    expect(await second.replay()).toEqual([])
  } finally {
    await second.close()
  }
})
