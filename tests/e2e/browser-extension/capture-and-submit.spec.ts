/**
 * The product loop: read a page, review it, hand it to Cognia, watch it run.
 *
 * The reason this lane exists. Every other suite reads the page through jsdom,
 * which has no layout — `getComputedStyle` there returns declared values, so a
 * `display: none` banner and an `opacity: 0` overlay both look visible. The
 * capture contract is denominated entirely in visibility, so the only place it
 * can actually be checked is a browser that lays the page out.
 *
 * Runs on the `granted` profile; `extension-profile.ts` records the one
 * difference and what it costs. Relevant here: with a host permission covering
 * `127.0.0.1`, `chrome.scripting.executeScript` on the fixture page succeeds
 * without a gesture. The shipped build reaches the same call through
 * `activeTab`, granted by a toolbar click, a keyboard command or a
 * context-menu choice — all browser chrome, none of it drivable. So these
 * specs prove the extractor and the pipeline; they do not prove the grant.
 */
import { CAPTURE_FIXTURE_HTML, FORBIDDEN_MARKERS, VISIBLE_MARKERS } from "./capture-fixture"
import { expect, pairThroughPanel, requestCapture, tabIdOf, test, type Page } from "./fixtures"
import type { MockHost } from "./mock-host"

test.use({ extensionProfile: "granted" })

/**
 * Pair, open the fixture page, and hand the panel a capture request for it.
 *
 * The request is written the way the background worker writes it, because the
 * three real gestures are all native UI. What they have in common is the
 * record they leave, so the specs start from that record and everything after
 * it is production code.
 */
async function captureFixturePage(
  {
    panel,
    mockHost,
    serviceWorker,
    context,
  }: {
    panel: Page
    mockHost: MockHost
    serviceWorker: import("@playwright/test").Worker
    context: import("@playwright/test").BrowserContext
  },
  {
    mode,
    query = "?utm_source=newsletter&token=secret#section-3",
    alreadyPaired = false,
  }: { mode: "selection" | "page"; query?: string; alreadyPaired?: boolean }
): Promise<{ pageUrl: string; content: Page }> {
  // A code is spent the moment it is redeemed, so a second capture in one test
  // must not pair again — it is the same browser, still connected.
  if (!alreadyPaired) {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await expect(panel.getByTestId("capture-empty")).toBeVisible()
  }

  const pageUrl = mockHost.servePage("article", CAPTURE_FIXTURE_HTML)
  const content = await context.newPage()
  await content.goto(`${pageUrl}${query}`)

  if (mode === "selection") {
    await content.evaluate(() => {
      const lead = document.querySelector("#lead")
      if (!lead) throw new Error("the fixture page has no lead paragraph")
      const range = document.createRange()
      range.selectNodeContents(lead)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const tabId = await tabIdOf(serviceWorker, `${pageUrl}${query}`)
  await requestCapture(serviceWorker, tabId, mode)
  // Reopening is what a context-menu click does: the worker records the
  // request and opens the panel, which reads it on mount.
  await panel.reload()
  await expect(panel.getByTestId("capture-preview")).toBeVisible()
  return { pageUrl, content }
}

test.describe("capturing a page", () => {
  test("previews the selection at an address with the tracking stripped", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    const { pageUrl } = await captureFixturePage(
      { panel, mockHost, serviceWorker, context },
      { mode: "selection" }
    )

    // The query carried `token=secret`. A query string looks like metadata and
    // routinely is not, so it goes unless the user asks for it back.
    await expect(panel.getByTestId("capture-url")).toHaveText(pageUrl)
    await expect(panel.getByTestId("capture-url")).not.toContainText("token")
    // And the offer to put it back is present, because this address had
    // something to add.
    await expect(panel.getByTestId("capture-full-url")).toBeVisible()
    await expect(panel.getByTestId("capture-bytes")).toBeVisible()
  })

  test("puts the full address back when the user asks, and only then", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })

    await panel.getByTestId("capture-full-url").click()
    await expect(panel.getByTestId("capture-url")).toContainText("token=secret")
    await expect(panel.getByTestId("capture-url")).toContainText("#section-3")
  })

  test("reads what a person sees, and nothing a page merely contains", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "page" })
    await panel.getByTestId("instruction").fill("Summarize the quarter")
    await panel.getByTestId("submit").click()
    await expect(panel.getByTestId("recent-list")).toBeVisible()

    const [submission] = mockHost.submissions()
    const captured = submission.readableText ?? ""
    expect(submission.captureMode).toBe("readable-page")

    for (const marker of VISIBLE_MARKERS) expect(captured).toContain(marker)
    // Reported as a list, so a regression that reopens several of these at
    // once is one failure naming all of them rather than one naming the first.
    expect(FORBIDDEN_MARKERS.filter((marker) => captured.includes(marker))).toEqual([])
  })

  test("sends the selection when there is one, not the whole page", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("instruction").fill("What does this say?")
    await panel.getByTestId("submit").click()
    await expect(panel.getByTestId("recent-list")).toBeVisible()

    const [submission] = mockHost.submissions()
    expect(submission.captureMode).toBe("selection")
    expect(submission.selectionText).toContain("VISIBLE-LEAD")
    // A selection is what the user already pointed at; sending the page around
    // it would send more than they chose.
    expect(submission.selectionText).not.toContain("VISIBLE-BODY")
    expect(submission.readableText).toBeUndefined()
  })
})

test.describe("submitting a capture", () => {
  test("turns one user action into exactly one task", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("instruction").fill("Summarize this")
    await panel.getByTestId("submit").click()

    await expect(panel.getByTestId("recent-list")).toBeVisible()
    expect(mockHost.sessionIds()).toHaveLength(1)
    expect(mockHost.submissions()[0].instruction).toBe("Summarize this")
    expect(mockHost.submissions()[0].sourceHost).toBe("127.0.0.1")

    // The write declares `idempotency: "required"`, so the key is a
    // declaration and not a precaution: the Host refuses the call without one,
    // and refuses a *read* that carries one.
    const rpc = mockHost.requests().filter((request) => request.path.startsWith("/api/_rpc/"))
    const submit = rpc.filter((request) => request.path.endsWith("browser_context_submit"))
    expect(submit).toHaveLength(1)
    expect(submit[0].idempotencyKey).toBe(mockHost.submissions()[0].submissionId)
    expect(
      rpc.filter((request) => !request.path.endsWith("submit")).every((r) => !r.idempotencyKey)
    ).toBe(true)
  })

  test("adds to a task it already started, instead of starting a second one", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("instruction").fill("Summarize this")
    await panel.getByTestId("submit").click()
    await expect(panel.getByTestId("recent-list")).toBeVisible()

    // The catalogue the panel is about to offer is the one the Host rebuilt
    // after that submission — the control does not exist until there is a
    // second thing to pick.
    await captureFixturePage(
      { panel, mockHost, serviceWorker, context },
      { mode: "selection", alreadyPaired: true }
    )
    await panel.getByTestId("target-select").click()
    await panel.getByRole("option", { name: mockHost.submissions()[0].title }).click()
    await panel.getByTestId("instruction").fill("And the pricing?")
    await panel.getByTestId("submit").click()

    await expect.poll(() => mockHost.submissions().length).toBe(2)
    // Two submissions, one conversation. That is the whole claim.
    expect(mockHost.sessionIds()).toHaveLength(1)
    expect(mockHost.submissions()[1].sessionId).toBe(mockHost.submissions()[0].sessionId)
    expect(mockHost.submissions()[1].targetId).toBe(
      `session:${mockHost.submissions()[0].sessionId}`
    )
  })

  test("clears the draft, so the next capture starts empty", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("instruction").fill("Summarize this")
    await panel.getByTestId("submit").click()

    // The captured page goes with it: leaving it on screen invites a second
    // submission of something the user believes they already sent.
    await expect(panel.getByTestId("capture-empty")).toBeVisible()
    await expect(panel.getByTestId("capture-preview")).toBeHidden()
  })

  test("follows the task's status without being reloaded", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("instruction").fill("Summarize this")
    await panel.getByTestId("submit").click()
    await expect(panel.getByTestId("status-queued")).toBeVisible()

    const { submissionId } = mockHost.submissions()[0]
    mockHost.setStatus(submissionId, "running")
    // The panel polls every three seconds while something is active; the wait
    // is on the observable state, never on the clock.
    await expect(panel.getByTestId("status-running")).toBeVisible()

    mockHost.setStatus(submissionId, "completed")
    await expect(panel.getByTestId("status-completed")).toBeVisible()
  })

  test("stores no page text, instruction or credential anywhere on disk", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "page" })
    await panel.getByTestId("instruction").fill("MARKER-INSTRUCTION summarize this")
    await panel.getByTestId("submit").click()
    await expect(panel.getByTestId("recent-list")).toBeVisible()

    const stored = JSON.stringify(
      await serviceWorker.evaluate(() => chrome.storage.local.get(null))
    )
    // The capture lives in the panel's React state and dies with the panel.
    // `chrome.storage.local` is readable by anything that can read the profile
    // directory, so what is absent from it is the whole guarantee.
    expect(stored).not.toContain("MARKER-INSTRUCTION")
    expect(stored).not.toContain("VISIBLE-LEAD")
    expect(stored).not.toContain("Bearer ")
    // And the consumed capture request did not linger — a request left behind
    // would re-read the page on every panel open, which is the "reads without
    // being asked" behaviour the design forbids.
    expect(stored).not.toContain("captureRequest")
  })
})

test.describe("running a saved template on a page", () => {
  test.use({
    hostTemplates: [
      {
        id: "template:tpl-1",
        kind: "template",
        label: "Summarize",
        isDefault: false,
        params: [
          { id: "tone", label: "Tone", required: true, kind: "string", defaultValue: "terse" },
        ],
      },
    ],
  })

  test("asks for the template's values instead of an instruction", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("target-select").click()
    await panel.getByRole("option", { name: "Summarize" }).click()

    // The template supplies the instruction on the Host, so the free-text box
    // is gone — showing both would invite two instructions in one turn.
    await expect(panel.getByTestId("target-params")).toBeVisible()
    await expect(panel.getByTestId("instruction")).toBeHidden()
    await expect(panel.getByTestId("param-tone")).toHaveValue("terse")

    await panel.getByTestId("param-tone").fill("plain English")
    await panel.getByTestId("submit").click()

    await expect.poll(() => mockHost.submissions().length).toBe(1)
    expect(mockHost.submissions()[0].targetId).toBe("template:tpl-1")
    expect(mockHost.submissions()[0].instruction).toContain("tone=plain English")
  })
})

test.describe("following a task without leaving the browser", () => {
  test("reads the answer, and only when asked for it", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("instruction").fill("Summarize this")
    await panel.getByTestId("submit").click()
    await expect(panel.getByTestId("recent-list")).toBeVisible()

    const submissionId = mockHost.submissions()[0].submissionId
    mockHost.setAnswer(submissionId, "The team plan is $20 per seat.")
    mockHost.setStatus(submissionId, "completed")

    // Nothing has been read yet: the list is polled and an answer is the
    // largest thing this contract returns.
    const before = mockHost
      .requests()
      .filter((request) => request.path.endsWith("browser_context_result")).length
    expect(before).toBe(0)

    await panel.getByTestId(`recent-answer-toggle-${submissionId}`).click()
    await expect(panel.getByTestId(`recent-answer-${submissionId}`)).toContainText(
      "The team plan is $20 per seat."
    )
  })

  test("stops a running task, and says so when the desktop is driving it", async ({
    panel,
    mockHost,
    serviceWorker,
    context,
  }) => {
    await captureFixturePage({ panel, mockHost, serviceWorker, context }, { mode: "selection" })
    await panel.getByTestId("instruction").fill("Summarize this")
    await panel.getByTestId("submit").click()
    await expect(panel.getByTestId("recent-list")).toBeVisible()
    const submissionId = mockHost.submissions()[0].submissionId
    mockHost.setStatus(submissionId, "running")

    // A refusal because somebody else holds the wheel is not a failure, and
    // the panel must not report one.
    mockHost.setDrivenElsewhere(true)
    await panel.getByTestId(`recent-stop-${submissionId}`).click()
    await expect(panel.getByTestId("submit-error")).toContainText(/driving this task/i)

    mockHost.setDrivenElsewhere(false)
    await panel.getByTestId(`recent-stop-${submissionId}`).click()
    await expect.poll(() => mockHost.submissions()[0].status).toBe("cancelled")
  })
})

test.describe("the Host's appearance", () => {
  test("is applied to the panel rather than approximated by it", async ({ panel, mockHost }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await expect(panel.getByTestId("capture-empty")).toBeVisible()

    // Values, not a theme id: a custom theme and an imported VSCode theme
    // arrive the same way, and there is no second copy of the palette in the
    // extension to fall behind.
    const applied = await panel.evaluate(() => ({
      background: document.documentElement.style.getPropertyValue("--background"),
      radius: document.documentElement.style.getPropertyValue("--radius"),
    }))
    expect(applied.background).toBe("oklch(1 0 0)")
    expect(applied.radius).toBe("0.625rem")
  })

  test("repaints when the Host's theme changes under an open panel", async ({
    panel,
    mockHost,
  }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await expect(panel.getByTestId("capture-empty")).toBeVisible()
    await expect(panel.locator("html")).toHaveClass(/light/)

    // What the desktop changing its theme looks like from here: the capability
    // answers differently, and the revision on the list is how a panel that has
    // already read the capability finds out.
    mockHost.setAppearanceMode("dark")
    mockHost.setCapabilityRevision("rev-2")

    await expect(panel.locator("html")).toHaveClass(/dark/, { timeout: 20_000 })
  })

  test("asks the Host to repaint instead of flipping the class itself", async ({
    panel,
    mockHost,
  }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await expect(panel.getByTestId("capture-empty")).toBeVisible()

    await panel.getByTestId("appearance-select").click()
    await panel.getByRole("option", { name: "Always dark" }).click()

    await expect(panel.locator("html")).toHaveClass(/dark/)
    // The palette came from the Host, not from a class the panel flipped over
    // the light one it already had.
    const requested = mockHost
      .requests()
      .filter((request) => request.path.endsWith("browser_companion_capability"))
    expect(requested.length).toBeGreaterThan(1)
  })
})
