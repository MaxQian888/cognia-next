/**
 * Benchmark: chat render cost for image- and chart-heavy conversations.
 *
 * Opt-in only — `CHAT_PERF_BENCH=1` (see below). It is deliberately NOT a CI
 * gate: it measures wall-clock and heap, both of which move with the machine,
 * and this repo's E2E suite is already flake-sensitive. Its job is to produce
 * a comparable JSON snapshot before and after a rendering change.
 *
 *   CHAT_PERF_BENCH=1 pnpm test:e2e -- --project=mobile-pixel-7 chat-render-perf
 *   CHAT_PERF_BENCH=1 CHAT_PERF_TIER=robust pnpm test:e2e -- --project=mobile-pixel-7 chat-render-perf
 *
 * Why the mobile shell: `DesktopChatWorkspace` renders `DesktopOnlyBanner`
 * whenever `platform !== "tauri"` (`components/desktop/desktop-chat-workspace.tsx:577`),
 * so a plain browser has exactly one reachable chat surface — the Capacitor
 * one. `MessageList`, `MessageRenderer` and `MarkdownRenderer` are shared
 * between the two shells, so the renderer cost measured here is the real
 * thing; only the desktop-only timeline minimap goes unexercised. The tighter
 * mobile memory envelope is a feature for a memory benchmark, not a
 * limitation.
 *
 * What it records, and why each one:
 *   - `imageBytes`      the payload the seeder actually embedded, so heap
 *                       numbers can be read against the input rather than
 *                       against a nominal image count.
 *   - `jsHeapUsedBytes` the headline number. Chat images are base64 `data:`
 *                       URLs inlined into `messages.parts`, so the same bytes
 *                       live in the Dexie row, the Zustand store and the DOM
 *                       attribute at once — virtualization unmounts the DOM
 *                       but cannot reclaim the strings.
 *   - `longTasks`       main-thread blocks >50ms during load and scroll: the
 *                       thing a user feels as jank.
 *   - `reactCommitMs`   `workflow-ai:react:chat:list` measures emitted by
 *                       `<PerfBoundary>`. Present against `pnpm dev`; absent
 *                       against a production static export, where PerfBoundary
 *                       returns children directly — recorded as null, not
 *                       asserted on.
 *   - `scroll`          worst and median frame gap over a scripted sweep.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

/** The message list's scroll container. */
const LOG = '[role="log"]'

interface Tier {
  turns: number
  images: number
  imageLongEdge: number
  charts: number
  chartNodes: number
  tableRows: number
  codeLines: number
}

/**
 * Two tiers, matching the two acceptance bars: `perf` must feel smooth,
 * `robust` only has to survive. `robust` seeds Retina-sized frames — the
 * default `screenshotScaling` is off, so that IS what a computer-use run
 * puts into a session today.
 */
const TIERS: Record<string, Tier> = {
  perf: {
    turns: 60,
    images: 40,
    imageLongEdge: 1568,
    charts: 12,
    chartNodes: 12,
    tableRows: 0,
    codeLines: 0,
  },
  robust: {
    turns: 200,
    images: 150,
    imageLongEdge: 2560,
    charts: 40,
    chartNodes: 40,
    tableRows: 5000,
    codeLines: 10000,
  },
}

const TIER_NAME = process.env.CHAT_PERF_TIER ?? "perf"

function resolveTier(): Tier {
  const base = TIERS[TIER_NAME] ?? TIERS.perf
  const num = (env: string | undefined, fallback: number) =>
    env === undefined ? fallback : Number(env)
  return {
    turns: num(process.env.CHAT_PERF_TURNS, base.turns),
    images: num(process.env.CHAT_PERF_IMAGES, base.images),
    imageLongEdge: num(process.env.CHAT_PERF_IMAGE_EDGE, base.imageLongEdge),
    charts: num(process.env.CHAT_PERF_CHARTS, base.charts),
    chartNodes: num(process.env.CHAT_PERF_CHART_NODES, base.chartNodes),
    tableRows: num(process.env.CHAT_PERF_TABLE_ROWS, base.tableRows),
    codeLines: num(process.env.CHAT_PERF_CODE_LINES, base.codeLines),
  }
}

declare global {
  interface Window {
    /** Long-task durations collected since the document loaded. */
    __chatPerfLongTasks?: number[]
  }
}

/**
 * Install the long-task observer before any app code runs. `longtask` is
 * Chromium-only; the try/catch keeps the script harmless on WebKit, where the
 * spec simply reports an empty list.
 */
async function observeLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__chatPerfLongTasks = []
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__chatPerfLongTasks!.push(entry.duration)
      }).observe({ entryTypes: ["longtask"] })
    } catch {
      // Unsupported engine — the snapshot records zero long tasks.
    }
  })
}

async function readLongTasks(page: Page): Promise<number[]> {
  return page.evaluate(() => window.__chatPerfLongTasks ?? [])
}

/**
 * `<PerfBoundary id="chat:list">` writes one `workflow-ai:react:chat:list`
 * measure per commit. Returns null when none exist — a production build elides
 * the Profiler entirely, and a benchmark that failed for that reason would be
 * reporting the build mode, not the renderer.
 */
async function readReactCommits(page: Page): Promise<{ count: number; totalMs: number } | null> {
  return page.evaluate(() => {
    const entries = performance
      .getEntriesByType("measure")
      .filter((e) => e.name === "workflow-ai:react:chat:list")
    if (entries.length === 0) return null
    return {
      count: entries.length,
      totalMs: Math.round(entries.reduce((sum, e) => sum + e.duration, 0)),
    }
  })
}

/** JS heap in bytes via CDP. Chromium-only; null elsewhere. */
async function readJsHeap(page: Page): Promise<number | null> {
  try {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable")
    const { metrics } = await cdp.send("Performance.getMetrics")
    await cdp.detach()
    return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? null
  } catch {
    return null
  }
}

interface ScrollMeasurement {
  worstFrameMs: number
  medianFrameMs: number
  samples: number
  /** Screens actually traversed before hitting the bottom. */
  screens: number
  /**
   * How much the reported scroll height moved while sweeping. This is the
   * virtualizer's estimate being corrected by real measurements: every row
   * whose estimate was wrong shifts the total, and the shift is what a user
   * feels as the content lurching under the cursor. Lower is better, and it is
   * the metric the row-height estimator moves.
   */
  scrollHeightDriftPx: number
}

/**
 * Sweep the list one screen at a time, sampling the gap between animation
 * frames.
 *
 * Stepping by a fixed *pixel* distance rather than a fixed fraction of the
 * range is what makes runs comparable: improving the row-height estimator
 * changes the virtual total, so a fraction-based sweep would silently cover
 * more content per step and report the extra work as a regression.
 */
async function measureScroll(page: Page, maxScreens: number): Promise<ScrollMeasurement> {
  return page.evaluate(
    async ({ selector, maxScreens }) => {
      const el = document.querySelector(selector) as HTMLElement | null
      if (!el) {
        return {
          worstFrameMs: -1,
          medianFrameMs: -1,
          samples: 0,
          screens: 0,
          scrollHeightDriftPx: -1,
        }
      }
      const gaps: number[] = []
      let last = performance.now()
      let minHeight = el.scrollHeight
      let maxHeight = el.scrollHeight
      let screens = 0

      const step = Math.max(1, el.clientHeight)
      for (let i = 0; i <= maxScreens; i++) {
        const target = step * i
        if (target > el.scrollHeight - el.clientHeight) break
        el.scrollTop = target
        screens = i
        // Two frames per step: the first commits the scroll, the second
        // catches the work it scheduled (measure passes, image decode).
        for (let frame = 0; frame < 2; frame++) {
          await new Promise<void>((done) =>
            requestAnimationFrame(() => {
              const now = performance.now()
              gaps.push(now - last)
              last = now
              minHeight = Math.min(minHeight, el.scrollHeight)
              maxHeight = Math.max(maxHeight, el.scrollHeight)
              done()
            })
          )
        }
      }

      const sorted = [...gaps].sort((a, b) => a - b)
      return {
        worstFrameMs: Math.round(sorted[sorted.length - 1] ?? 0),
        medianFrameMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        samples: gaps.length,
        screens,
        scrollHeightDriftPx: Math.round(maxHeight - minHeight),
      }
    },
    { selector: LOG, maxScreens }
  )
}

test.describe("chat render performance", () => {
  test.skip(
    process.env.CHAT_PERF_BENCH !== "1",
    "Benchmark — set CHAT_PERF_BENCH=1 to run. Never a CI gate."
  )
  test.describe.configure({ mode: "serial" })

  test(`@perf image- and chart-heavy conversation (${TIER_NAME} tier)`, async ({
    page,
  }, testInfo) => {
    const tier = resolveTier()
    // Seeding alone encodes `images` full-noise frames in page context.
    test.setTimeout(600_000)

    await observeLongTasks(page)
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone")

    await page.waitForFunction(() => typeof window.__cogniaSeedConversation === "function", null, {
      timeout: 60_000,
    })

    const seedStart = Date.now()
    const seeded = await page.evaluate(
      async ({ turns, ...media }) => window.__cogniaSeedConversation!({ turns, media }),
      tier
    )
    const seedMs = Date.now() - seedStart

    const openStart = Date.now()
    await page.goto(`/?session=${seeded.sessionId}&message=seed-u-0`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page.locator(LOG)).toBeVisible({ timeout: 120_000 })
    // The list is up; wait for a row so "opened" means "showed content".
    await expect(page.locator(`${LOG} [data-msg-id]`).first()).toBeVisible({
      timeout: 120_000,
    })
    const openMs = Date.now() - openStart

    // 40 screens: enough to traverse the perf tier end to end and to get well
    // into the robustness tier, at a fixed cost per step.
    const scroll = await measureScroll(page, 40)
    const longTasks = await readLongTasks(page)
    const snapshot = {
      tier: TIER_NAME,
      project: testInfo.project.name,
      config: tier,
      messages: seeded.messageIds.length,
      imageBytes: seeded.imageBytes,
      seedMs,
      openMs,
      jsHeapUsedBytes: await readJsHeap(page),
      reactCommits: await readReactCommits(page),
      longTasks: {
        count: longTasks.length,
        totalMs: Math.round(longTasks.reduce((sum, d) => sum + d, 0)),
        worstMs: Math.round(Math.max(0, ...longTasks)),
      },
      scroll,
    }

    const out = resolve(
      process.cwd(),
      `test-results/chat-render-perf-${TIER_NAME}-${testInfo.project.name}.json`
    )
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(snapshot, null, 2))
    await testInfo.attach("chat-render-perf", {
      body: JSON.stringify(snapshot, null, 2),
      contentType: "application/json",
    })
    // The snapshot IS this test's output — printing it makes a run readable
    // without opening the JSON file.
    console.log("[chat-render-perf]", JSON.stringify(snapshot))

    // The only assertions are robustness invariants — timings are reported,
    // never gated, because they move with the machine.
    expect(snapshot.messages).toBeGreaterThan(0)
    expect(scroll.samples).toBeGreaterThan(0)
    // Survived the sweep: the list is still mounted and still has rows.
    await expect(page.locator(`${LOG} [data-msg-id]`).first()).toBeVisible()
  })
})
