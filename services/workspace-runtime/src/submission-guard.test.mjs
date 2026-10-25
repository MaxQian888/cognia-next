import assert from "node:assert/strict"
import test from "node:test"

import {
  REPORTED_HOLD_MS,
  SUBMISSION_GRACE_MS,
  SubmissionGuard,
  UNREPORTED_HOLD_MS,
  isSubmissionRequest,
} from "./submission-guard.mjs"

/** A guard on a manual clock: `advance` fires due timers in order. */
function manualGuard(options = {}) {
  let clock = 1_000
  let ids = 0
  const timers = new Map()
  let timerSeq = 0
  const guard = new SubmissionGuard({
    now: () => clock,
    createId: () => `h${++ids}`,
    setTimer: (callback, ms) => {
      const id = ++timerSeq
      timers.set(id, { at: clock + ms, callback })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  })
  const advance = async (ms) => {
    const until = clock + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      clock = due[1].at
      due[1].callback()
      await Promise.resolve()
    }
    clock = until
    await Promise.resolve()
  }
  return { guard, advance, timers }
}

const POST = { url: "https://forms.example.com/submit", method: "post", resourceType: "document" }

test("only data-carrying http(s) and ws(s) requests are submissions", () => {
  assert.equal(isSubmissionRequest("POST", "https://a.example/x"), true)
  assert.equal(isSubmissionRequest("put", "http://127.0.0.1:4811/api"), true)
  assert.equal(isSubmissionRequest("WS", "wss://chat.example/socket"), true)
  for (const method of ["GET", "head", "OPTIONS"]) {
    assert.equal(isSubmissionRequest(method, "https://a.example/x"), false)
  }
  assert.equal(isSubmissionRequest("POST", "data:text/plain,x"), false)
  assert.equal(isSubmissionRequest("POST", "chrome-extension://abc/x"), false)
  assert.equal(isSubmissionRequest("POST", "not a url"), false)
})

test("off lets everything through and reports nothing", async () => {
  const { guard } = manualGuard()
  const end = guard.beginAction("p1")
  assert.equal(await guard.submit("p1", POST), "allow")
  end()
  assert.deepEqual((await guard.drain("p1")).reports, [])
})

test("observe reports a submission in the window and sends it at once", async () => {
  const { guard } = manualGuard()
  guard.configure("observe")
  const end = guard.beginAction("p1")
  assert.equal(await guard.submit("p1", POST), "allow")
  end()
  const { reports, windowOpen } = await guard.drain("p1")
  assert.equal(windowOpen, true)
  assert.deepEqual(reports, [
    {
      id: "h1",
      url: "https://forms.example.com/submit",
      method: "POST",
      resourceType: "document",
      navigation: false,
      held: false,
      at: 1_000,
    },
  ])
  assert.deepEqual((await guard.drain("p1")).reports, [], "a drain empties the page's reports")
})

test("the window stays open for the grace period after the action, then closes", async () => {
  const { guard, advance } = manualGuard()
  guard.configure("observe")
  assert.equal(await guard.submit("p1", POST), "allow")
  assert.deepEqual((await guard.drain("p1")).reports, [], "no window, no report")

  const end = guard.beginAction("p1")
  await advance(60_000)
  assert.equal(guard.windowOpen("p1"), true, "open for as long as the action runs")
  end()
  await advance(SUBMISSION_GRACE_MS)
  assert.equal(guard.windowOpen("p1"), true)
  await guard.submit("p1", POST)
  await advance(1)
  assert.equal(guard.windowOpen("p1"), false)
  await guard.submit("p1", POST)
  assert.equal((await guard.drain("p1")).reports.length, 1)
})

test("windows are per page: another tab's traffic is not charged to this action", async () => {
  const { guard } = manualGuard()
  guard.configure("hold")
  guard.beginAction("p1")
  assert.equal(await guard.submit("p2", POST), "allow")
  assert.deepEqual((await guard.drain("p2")).reports, [])
  assert.equal(guard.attribute("p2", null), null)
  assert.equal(guard.attribute("p2", "p1"), "p1", "a tab the acting page opened is charged to it")
  assert.equal(
    guard.attribute(null, null),
    "p1",
    "a request no page claims goes to the acting page"
  )
})

test("a request no page claims goes to the page whose action began last", async () => {
  const { guard, advance } = manualGuard()
  guard.beginAction("p1")
  await advance(10)
  guard.beginAction("p2")
  assert.equal(guard.attribute(null, null), "p2")
})

test("hold waits for the host's answer", async () => {
  const { guard } = manualGuard()
  guard.configure("hold")
  const end = guard.beginAction("p1")
  const allowed = guard.submit("p1", { ...POST, navigation: true })
  const refused = guard.submit("p1", { url: "https://api.example/x", method: "PUT" })
  end()
  const { reports } = await guard.drain("p1")
  assert.deepEqual(
    reports.map(({ id, held, navigation }) => ({ id, held, navigation })),
    [
      { id: "h1", held: true, navigation: true },
      { id: "h2", held: true, navigation: false },
    ]
  )
  assert.deepEqual(guard.resolve("h1", "allow"), { id: "h1", decision: "allow" })
  guard.resolve("h2", "refuse")
  assert.equal(await allowed, "allow")
  assert.equal(await refused, "refuse")
  assert.throws(() => guard.resolve("h1", "allow"), { code: "browser_submission_not_found" })
})

test("a decision other than allow or refuse is rejected", async () => {
  const { guard } = manualGuard()
  guard.configure("hold")
  guard.beginAction("p1")
  void guard.submit("p1", POST)
  assert.throws(() => guard.resolve("h1", "maybe"), { code: "browser_submission_decision_invalid" })
})

test("a hold the host never drains is refused; one it drained waits longer", async () => {
  const { guard, advance } = manualGuard()
  guard.configure("hold")
  guard.beginAction("p1")
  const unreported = guard.submit("p1", POST)
  await advance(UNREPORTED_HOLD_MS)
  assert.equal(await unreported, "refuse")

  const reported = guard.submit("p1", POST)
  await guard.drain("p1")
  await advance(UNREPORTED_HOLD_MS + 1)
  let settled = false
  void reported.then(() => (settled = true))
  await Promise.resolve()
  assert.equal(settled, false, "a drained hold outlives the unreported timeout")
  await advance(REPORTED_HOLD_MS)
  assert.equal(await reported, "refuse")
})

test("drain waits for a report while the window is open", async () => {
  const { guard, advance } = manualGuard()
  guard.configure("observe")
  const end = guard.beginAction("p1")
  end()
  const drained = guard.drain("p1", 2_000)
  await advance(100)
  await guard.submit("p1", POST)
  const { reports } = await drained
  assert.equal(reports.length, 1)
})

test("drain stops waiting when the window closes, and at once without a window", async () => {
  const { guard, advance } = manualGuard()
  guard.configure("observe")
  assert.deepEqual(await guard.drain("p1", 5_000), { reports: [], windowOpen: false })

  const end = guard.beginAction("p1")
  end()
  let done = false
  const drained = guard.drain("p1", 10_000).then((result) => {
    done = true
    return result
  })
  await advance(SUBMISSION_GRACE_MS)
  assert.equal(done, false)
  await advance(2)
  assert.deepEqual(await drained, { reports: [], windowOpen: false })
})

test("leaving hold sends what was held; closing a page or the guard refuses", async () => {
  const { guard } = manualGuard()
  guard.configure("hold")
  guard.beginAction("p1")
  guard.beginAction("p2")
  const first = guard.submit("p1", POST)
  guard.configure("observe")
  assert.equal(await first, "allow")

  guard.configure("hold")
  const onP1 = guard.submit("p1", POST)
  const onP2 = guard.submit("p2", POST)
  guard.forgetPage("p1")
  assert.equal(await onP1, "refuse")
  assert.equal(guard.windowOpen("p1"), false)
  guard.close()
  assert.equal(await onP2, "refuse")
})

test("an invalid mode is rejected", () => {
  const { guard } = manualGuard()
  assert.throws(() => guard.configure("enforce"), { code: "browser_submission_mode_invalid" })
})
