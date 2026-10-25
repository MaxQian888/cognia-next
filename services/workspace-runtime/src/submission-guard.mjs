/**
 * Browser submission guard (ADR-0239 phase 2b): what an agent's browser action
 * sends to a site, observed or held until the host decides.
 *
 * An agent action (`browser.act`, `.press-key`, `.drag`, `.evaluate`, history,
 * answering a dialog) opens a window on the page it acts on, which stays open
 * for {@link SUBMISSION_GRACE_MS} after the action returns: a page may submit
 * a moment after the click (measured at 1.8 s in the WP10 spike,
 * `docs/research/2026-10-25-browser-submit-signal.md`). A request the page
 * sends in its window that carries data (any method but GET, HEAD and
 * OPTIONS) and every WebSocket frame it sends count as a submission of that
 * action. GET-carried data is not caught: holding every GET would ask on
 * every page load, so it is a known gap.
 *
 * - `off` (default): nothing is watched; a session the host never configured
 *   behaves as before.
 * - `observe` (the browser category in shadow mode): each submission is
 *   reported and sent at once.
 * - `hold` (enforce): each submission waits until the host resolves it with
 *   `allow` or `refuse`. One the host never learns of (no drain within
 *   {@link UNREPORTED_HOLD_MS}) is refused, and so is one it learned of but
 *   never answered within {@link REPORTED_HOLD_MS}: an unanswered hold fails
 *   towards not sending.
 *
 * In `hold` the host drains and decides while the action is still running:
 * a held navigation keeps the action waiting in Playwright until it is
 * answered or Playwright's own timeout passes.
 *
 * Windows and reports are per page, so tabs of one shared session that belong
 * to different tasks (ADR-0214) never hold or report each other's traffic.
 * The host learns of submissions by draining a page's reports
 * (`browser.submission.drain`); there is no push channel from the runtime.
 *
 * Pure bookkeeping: it never touches Playwright. The browser service maps
 * requests and frames onto {@link SubmissionGuard#submit} and carries out the
 * decision.
 */

import { RemoteBrowserError } from "./browser-errors.mjs"

export const SUBMISSION_GUARD_MODES = Object.freeze(["off", "observe", "hold"])
export const SUBMISSION_GRACE_MS = 3000
export const UNREPORTED_HOLD_MS = 60_000
export const REPORTED_HOLD_MS = 30 * 60_000
/** The longest a drain may wait for a report. */
export const MAX_DRAIN_WAIT_MS = 10_000
/** Reports kept per page before the oldest observation is dropped. */
const MAX_REPORTS_PER_PAGE = 100

const PASSIVE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const SUBMISSION_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"])

/** Whether a request carries data to a site: an http(s) or ws(s) request that is not passive. */
export function isSubmissionRequest(method, url) {
  if (PASSIVE_METHODS.has(String(method).toUpperCase())) return false
  try {
    return SUBMISSION_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

export function assertSubmissionGuardMode(mode) {
  if (!SUBMISSION_GUARD_MODES.includes(mode)) {
    throw new RemoteBrowserError(
      "browser_submission_mode_invalid",
      `Submission guard mode must be one of ${SUBMISSION_GUARD_MODES.join(", ")}`
    )
  }
  return mode
}

export class SubmissionGuard {
  constructor({
    now = () => Date.now(),
    createId = () => crypto.randomUUID(),
    graceMs = SUBMISSION_GRACE_MS,
    unreportedHoldMs = UNREPORTED_HOLD_MS,
    reportedHoldMs = REPORTED_HOLD_MS,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    this.now = now
    this.createId = createId
    this.graceMs = graceMs
    this.unreportedHoldMs = unreportedHoldMs
    this.reportedHoldMs = reportedHoldMs
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.mode = "off"
    /** pageId → { active, until, startedAt } */
    this.windows = new Map()
    /** pageId → report[] not yet drained */
    this.reports = new Map()
    /** holdId → { pageId, settle, timer } */
    this.holds = new Map()
    /** pageId → Set<() => void>, woken when a report or a window change arrives */
    this.waiters = new Map()
  }

  configure(mode) {
    this.mode = assertSubmissionGuardMode(mode)
    if (mode !== "hold") {
      // Nothing may stay held once holding stops; the host decided to send.
      for (const holdId of [...this.holds.keys()]) this.settle(holdId, "allow")
    }
    return this.mode
  }

  /** Open `pageId`'s window for one action; call the returned function when it ends. */
  beginAction(pageId) {
    if (!pageId) return () => undefined
    const window = this.windows.get(pageId) ?? { active: 0, until: 0, startedAt: 0, held: 0 }
    window.active += 1
    window.startedAt = this.now()
    this.windows.set(pageId, window)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      window.active = Math.max(0, window.active - 1)
      if (window.active === 0) window.until = this.now() + this.graceMs
      this.wake(pageId)
    }
  }

  windowOpen(pageId) {
    const window = pageId ? this.windows.get(pageId) : undefined
    if (!window) return false
    return window.active > 0 || this.now() <= window.until
  }

  /**
   * The page a request is charged to: its own when its window is open, else
   * its opener's (a form posting into a new tab), else — for a request no
   * page claims, such as a worker's — the page whose action began last among
   * those with an open window. `null` when no window covers it.
   */
  attribute(pageId, openerPageId) {
    if (pageId && this.windowOpen(pageId)) return pageId
    if (openerPageId && this.windowOpen(openerPageId)) return openerPageId
    if (pageId) return null
    let latest = null
    let latestAt = -1
    for (const [candidate, window] of this.windows) {
      if (this.windowOpen(candidate) && window.startedAt > latestAt) {
        latest = candidate
        latestAt = window.startedAt
      }
    }
    return latest
  }

  /**
   * A submission from `pageId`'s window. Resolves `"allow"` or `"refuse"`:
   * at once unless the guard holds, else when the host answers or a timeout
   * refuses it. `entry` is `{ url, method, resourceType, navigation }`.
   */
  submit(pageId, entry) {
    if (this.mode === "off" || !pageId || !this.windowOpen(pageId)) {
      return Promise.resolve("allow")
    }
    const id = this.createId()
    const held = this.mode === "hold"
    this.pushReport(pageId, {
      id,
      url: String(entry.url),
      method: String(entry.method).toUpperCase(),
      resourceType: String(entry.resourceType ?? "other"),
      navigation: Boolean(entry.navigation),
      held,
      at: this.now(),
    })
    if (!held) return Promise.resolve("allow")
    const window = this.windows.get(pageId)
    window.held += 1
    return new Promise((resolve) => {
      const timer = this.setTimer(() => this.settle(id, "refuse"), this.unreportedHoldMs)
      this.holds.set(id, { pageId, settle: resolve, timer })
    })
  }

  /** How many submissions were ever held on `pageId`; a change means a hold happened. */
  heldCount(pageId) {
    return this.windows.get(pageId)?.held ?? 0
  }

  pushReport(pageId, report) {
    const list = this.reports.get(pageId) ?? []
    list.push(report)
    if (list.length > MAX_REPORTS_PER_PAGE) {
      // Drop the oldest observation; a held report is never dropped, since
      // the host must learn of it to answer it.
      const index = list.findIndex((candidate) => !candidate.held)
      if (index >= 0) list.splice(index, 1)
    }
    this.reports.set(pageId, list)
    this.wake(pageId)
  }

  wake(pageId) {
    const waiters = this.waiters.get(pageId)
    if (!waiters) return
    this.waiters.delete(pageId)
    for (const wake of waiters) wake()
  }

  /**
   * `pageId`'s reports since the last drain. With `waitMs`, waits until one
   * arrives, the page's window closes or the time passes, whichever is first;
   * a page with no open window and no report returns at once. Held reports
   * now wait for the host's answer for up to {@link REPORTED_HOLD_MS}.
   */
  async drain(pageId, waitMs = 0) {
    const wait = Math.max(0, Math.min(Number(waitMs) || 0, MAX_DRAIN_WAIT_MS))
    if (wait > 0 && !(this.reports.get(pageId)?.length > 0) && this.windowOpen(pageId)) {
      await new Promise((resolve) => {
        const waiters = this.waiters.get(pageId) ?? new Set()
        let timer = null
        const done = () => {
          waiters.delete(done)
          if (timer !== null) this.clearTimer(timer)
          resolve()
        }
        waiters.add(done)
        this.waiters.set(pageId, waiters)
        const window = this.windows.get(pageId)
        const closesIn =
          window && window.active === 0 ? Math.max(0, window.until - this.now()) : wait
        timer = this.setTimer(done, Math.min(wait, closesIn + 1))
      })
    }
    const reports = this.reports.get(pageId) ?? []
    this.reports.delete(pageId)
    for (const report of reports) {
      const hold = report.held ? this.holds.get(report.id) : undefined
      if (!hold) continue
      this.clearTimer(hold.timer)
      hold.timer = this.setTimer(() => this.settle(report.id, "refuse"), this.reportedHoldMs)
    }
    return { reports, windowOpen: this.windowOpen(pageId) }
  }

  /** Answer a held submission. */
  resolve(holdId, decision) {
    if (decision !== "allow" && decision !== "refuse") {
      throw new RemoteBrowserError(
        "browser_submission_decision_invalid",
        'A submission decision is "allow" or "refuse"'
      )
    }
    if (!this.holds.has(holdId)) {
      throw new RemoteBrowserError(
        "browser_submission_not_found",
        "No held submission has this id; it may have timed out"
      )
    }
    this.settle(holdId, decision)
    return { id: holdId, decision }
  }

  settle(holdId, decision) {
    const hold = this.holds.get(holdId)
    if (!hold) return
    this.holds.delete(holdId)
    this.clearTimer(hold.timer)
    hold.settle(decision)
  }

  /** A page closed: refuse what it holds and forget its window and reports. */
  forgetPage(pageId) {
    for (const [holdId, hold] of [...this.holds]) {
      if (hold.pageId === pageId) this.settle(holdId, "refuse")
    }
    this.windows.delete(pageId)
    this.reports.delete(pageId)
    this.wake(pageId)
  }

  /** The session is going away: refuse every hold and wake every drain. */
  close() {
    for (const holdId of [...this.holds.keys()]) this.settle(holdId, "refuse")
    for (const pageId of [...this.waiters.keys()]) this.wake(pageId)
    this.windows.clear()
    this.reports.clear()
  }
}
