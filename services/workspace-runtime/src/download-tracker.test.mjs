import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { LocalDownloadTracker } from "./download-tracker.mjs"

class FakeDownload {
  constructor({
    url = "https://files.example/report.pdf",
    name = "report.pdf",
    bytes = "PDF",
  } = {}) {
    this._url = url
    this._name = name
    this.bytes = bytes
    this.cancelled = false
    this.finished = new Promise((resolve, reject) => {
      this.complete = () => resolve("/staging/guid-1")
      this.fail = (reason) => {
        this.failureReason = reason
        reject(new Error(reason))
      }
    })
  }
  url() {
    return this._url
  }
  suggestedFilename() {
    return this._name
  }
  path() {
    return this.finished
  }
  async failure() {
    return this.failureReason ?? null
  }
  async saveAs(target) {
    await fs.writeFile(target, this.bytes)
  }
  async cancel() {
    this.cancelled = true
    this.fail("canceled")
  }
}

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-downloads-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const events = []
  let id = 0
  let now = 1_000
  const cancelled = []
  const tracker = new LocalDownloadTracker({
    sessionId: "s1",
    backend: "local-chromium",
    downloadsDir: dir,
    createId: () => `d${++id}`,
    publish: (event) => events.push(event),
    cancelByGuid: async (guid) => cancelled.push(guid),
    now: () => now,
    progressIntervalMs: 100,
    ...options,
  })
  return { tracker, dir, events, cancelled, advance: (ms) => (now += ms) }
}

test("tracks a Playwright download through CDP progress into a collision-safe file", async (t) => {
  const { tracker, dir, events, advance } = await fixture(t)
  await fs.writeFile(path.join(dir, "report.pdf"), "existing")
  const download = new FakeDownload()
  const settled = tracker.onPlaywrightDownload(download)
  tracker.onWillBegin({
    guid: "g1",
    url: "https://files.example/report.pdf",
    suggestedFilename: "report.pdf",
  })
  advance(200)
  tracker.onProgress({ guid: "g1", totalBytes: 10, receivedBytes: 4, state: "inProgress" })
  // Throttled: a second progress inside the interval publishes nothing.
  advance(10)
  tracker.onProgress({ guid: "g1", totalBytes: 10, receivedBytes: 6, state: "inProgress" })
  advance(200)
  download.complete()
  const summary = await settled

  assert.equal(summary.state, "completed")
  assert.equal(summary.filename, "report (1).pdf")
  assert.equal(summary.savedPath, path.join(dir, "report (1).pdf"))
  assert.equal(summary.size, 3)
  assert.equal(summary.mimeType, "application/pdf")
  assert.equal(summary.backend, "local-chromium")
  assert.equal(summary.url, "https://files.example/report.pdf")
  assert.equal(await fs.readFile(path.join(dir, "report (1).pdf"), "utf8"), "PDF")
  assert.equal(await fs.readFile(path.join(dir, "report.pdf"), "utf8"), "existing")
  assert.deepEqual(
    events.map((event) => [event.type, event.download.state, event.download.receivedBytes]),
    [
      ["download.updated", "in_progress", 0],
      ["download.updated", "in_progress", 4],
      ["download.updated", "completed", 3],
    ]
  )
  assert.equal(events[0].sessionId, "s1")
})

test("links a CDP-first download to the later Playwright event", async (t) => {
  const { tracker, events } = await fixture(t)
  tracker.onWillBegin({ guid: "g1", url: "https://x.example/a.zip", suggestedFilename: "a.zip" })
  const download = new FakeDownload({ url: "https://x.example/a.zip", name: "a.zip" })
  const settled = tracker.onPlaywrightDownload(download)
  download.complete()
  const summary = await settled
  assert.equal(tracker.list().length, 1)
  assert.equal(summary.id, "d1")
  assert.equal(events.filter((event) => event.download.state === "in_progress").length, 1)
})

test("cancel marks the download cancelled and cancels the Playwright artifact", async (t) => {
  const { tracker } = await fixture(t)
  const download = new FakeDownload()
  const settled = tracker.onPlaywrightDownload(download)
  const [record] = tracker.list()
  const cancelled = await tracker.cancel(record.id)
  assert.equal(cancelled.state, "cancelled")
  assert.equal(download.cancelled, true)
  assert.equal((await settled).state, "cancelled")
  await assert.rejects(
    () => tracker.cancel(record.id),
    (error) => error.code === "browser_download_not_cancellable"
  )
})

test("a failed download reports failed with the Playwright reason", async (t) => {
  const { tracker } = await fixture(t)
  const download = new FakeDownload()
  const settled = tracker.onPlaywrightDownload(download)
  download.fail("net::ERR_FAILED")
  const summary = await settled
  assert.equal(summary.state, "failed")
  assert.equal(summary.error, "net::ERR_FAILED")
})

test("user-chrome downloads complete from CDP alone and can be cancelled by guid", async (t) => {
  const { tracker, cancelled } = await fixture(t, { backend: "user-chrome" })
  tracker.onWillBegin({ guid: "g1", url: "https://x.example/a.csv", suggestedFilename: "a.csv" })
  tracker.onProgress({
    guid: "g1",
    totalBytes: 5,
    receivedBytes: 5,
    state: "completed",
    filePath: "/Users/me/Downloads/a (2).csv",
  })
  const [done] = tracker.list()
  assert.equal(done.state, "completed")
  assert.equal(done.savedPath, "/Users/me/Downloads/a (2).csv")
  assert.equal(done.filename, "a (2).csv")
  assert.equal(done.backend, "user-chrome")

  tracker.onWillBegin({ guid: "g2", url: "https://x.example/b.csv", suggestedFilename: "b.csv" })
  const pending = tracker.list().find((item) => item.filename === "b.csv")
  assert.equal((await tracker.cancel(pending.id)).state, "cancelled")
  assert.deepEqual(cancelled, ["g2"])
  tracker.onProgress({ guid: "g2", state: "canceled" })
  assert.equal(tracker.list().find((item) => item.id === pending.id).state, "cancelled")

  tracker.onWillBegin({ guid: "g3", url: "https://x.example/c.csv", suggestedFilename: "c.csv" })
  tracker.onProgress({ guid: "g3", state: "canceled" })
  assert.equal(tracker.list().find((item) => item.filename === "c.csv").state, "failed")
})

test("save copies without overwriting, delete removes the downloaded file", async (t) => {
  const { tracker, dir } = await fixture(t)
  const download = new FakeDownload()
  const settled = tracker.onPlaywrightDownload(download)
  await assert.rejects(
    () => tracker.save("d1", path.join(dir, "copy.pdf")),
    (error) => error.code === "browser_download_not_ready"
  )
  download.complete()
  const summary = await settled
  await assert.rejects(
    () => tracker.save(summary.id, "relative.pdf"),
    (error) => error.code === "browser_download_target_invalid"
  )
  const target = path.join(dir, "copy.pdf")
  const saved = await tracker.save(summary.id, target)
  assert.equal(saved.state, "saved")
  assert.equal(saved.savedPath, target)
  await assert.rejects(
    () => tracker.save(summary.id, target),
    (error) => error.code === "browser_download_target_exists"
  )
  assert.deepEqual(await tracker.delete(summary.id), { deleted: true, id: summary.id })
  await assert.rejects(() => fs.stat(path.join(dir, "report.pdf")), { code: "ENOENT" })
  assert.equal(await fs.readFile(target, "utf8"), "PDF")
  assert.deepEqual(tracker.list(), [])
  await assert.rejects(
    () => tracker.delete(summary.id),
    (error) => error.code === "browser_download_not_found"
  )
})

test("save refuses symlink targets and symlinked parent directories", async (t) => {
  const { tracker, dir } = await fixture(t)
  const download = new FakeDownload()
  const settled = tracker.onPlaywrightDownload(download)
  download.complete()
  const summary = await settled

  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-save-elsewhere-"))
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }))

  // A dangling symlink at the target would otherwise be followed on create.
  const dangling = path.join(dir, "dangling.pdf")
  await fs.symlink(path.join(elsewhere, "planted.pdf"), dangling)
  await assert.rejects(
    () => tracker.save(summary.id, dangling),
    (error) => error.code === "browser_download_target_invalid"
  )
  await assert.rejects(() => fs.stat(path.join(elsewhere, "planted.pdf")), { code: "ENOENT" })

  // A symlink to an existing file is refused, and the file is untouched.
  const victim = path.join(elsewhere, "victim.txt")
  await fs.writeFile(victim, "original")
  const linked = path.join(dir, "linked.pdf")
  await fs.symlink(victim, linked)
  await assert.rejects(
    () => tracker.save(summary.id, linked),
    (error) => error.code === "browser_download_target_invalid"
  )
  assert.equal(await fs.readFile(victim, "utf8"), "original")

  // A parent directory that is a symlink is refused.
  const linkedDir = path.join(dir, "linked-dir")
  await fs.symlink(elsewhere, linkedDir)
  await assert.rejects(
    () => tracker.save(summary.id, path.join(linkedDir, "copy.pdf")),
    (error) => error.code === "browser_download_target_invalid"
  )
  await assert.rejects(() => fs.stat(path.join(elsewhere, "copy.pdf")), { code: "ENOENT" })

  // A missing parent directory is refused.
  await assert.rejects(
    () => tracker.save(summary.id, path.join(dir, "missing", "copy.pdf")),
    (error) => error.code === "browser_download_target_invalid"
  )
})

test("registers runtime-produced files as completed downloads", async (t) => {
  const { tracker, dir, events } = await fixture(t)
  const filePath = path.join(dir, "page.pdf")
  await fs.writeFile(filePath, "12345")
  const summary = await tracker.addCompletedFile({ filePath, url: "https://x.example/" })
  assert.equal(summary.state, "completed")
  assert.equal(summary.size, 5)
  assert.equal(events.at(-1).download.savedPath, filePath)
})
