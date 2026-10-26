/** Exercise the real permission gate, broker, overlay and backend outcome. */
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { MIN_CONSENT_TIMEOUT_MS } from "@/lib/automation/consent-durations"

declare global {
  interface Window {
    __automationProbeResult?: { error: string } | null
    __automationConcurrentResults?: string[]
  }
}

async function beginProbe(page: Page, sessionKey: string): Promise<void> {
  await page.evaluate((key) => {
    window.__automationProbeResult = null
    // The invalid ref can reach the backend only after consent; it can never
    // generate OS input, even if the operator approves this test's prompt.
    void window
      .__cogniaE2EAutomation!.click(
        { kind: "element", elementRef: "__e2e_missing_element__" },
        {},
        {
          surface: "workflow",
          sessionKey: key,
          forceTier: "perCall",
        }
      )
      .then(
        () => {
          window.__automationProbeResult = { error: "unexpected success" }
        },
        (error: unknown) => {
          window.__automationProbeResult = {
            error:
              error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : JSON.stringify(error),
          }
        }
      )
  }, sessionKey)
}

async function expectResult(page: Page, error: RegExp): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__automationProbeResult?.error)).toMatch(error)
}

const overlay = (page: Page) =>
  page.getByRole("dialog", { name: /automation consent|自动化操作确认/i })

test.describe("real automation consent", () => {
  test.beforeEach(async ({ page, automationSettings }) => {
    await page.evaluate(async (settings) => {
      const api = window.__cogniaE2EAutomation!
      await api.setEnabled(true)
      await api.settingsSet({
        ...settings,
        enabled: true,
        consentTimeoutMs: 5_000,
        perSurface: {
          ...settings.perSurface,
          workflow: { ...settings.perSurface.workflow, tier: "perCall" },
        },
      })
    }, automationSettings)
  })

  test("recovers an emitted request after delayed listener registration without reloading", async ({
    page,
  }) => {
    await page.evaluate(async () => {
      const api = window.__cogniaE2EAutomation!
      await api.settingsSet({ ...(await api.settingsGet()), consentTimeoutMs: 30_000 })
    })
    try {
      expect(
        await page.evaluate(() =>
          window.__cogniaE2ERestartLocalTransport!({ delayConsentListener: true })
        )
      ).toBe(true)
      await page.waitForFunction(() => window.__consentListenerGate?.held)
      await beginProbe(page, "e2e-before-listen")
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.__cogniaE2EAutomation!.consentPending()).length)
        )
        .toBe(1)
      await expect(overlay(page)).toBeHidden()
      await page.evaluate(() => window.__consentListenerGate!.release())
      await expect(overlay(page)).toBeVisible()
      await overlay(page)
        .getByRole("button", { name: /^(Allow once|本次允许)$/ })
        .click()
      await expectResult(page, /stale[_ ]?element/i)
      expect(
        await page.evaluate(
          async () => (await window.__cogniaE2EAutomation!.consentPending()).length
        )
      ).toBe(0)
    } finally {
      await page.evaluate(() => window.__consentListenerGate?.release())
    }
  })

  test("recovers a pending broker request on the first mount after reload", async ({ page }) => {
    const auditIds = await page.evaluate(async () => {
      const api = window.__cogniaE2EAutomation!
      await api.settingsSet({ ...(await api.settingsGet()), consentTimeoutMs: 60_000 })
      return (await api.auditSnapshot()).map((entry) => entry.id)
    })
    try {
      expect(
        await page.evaluate(() =>
          window.__cogniaE2ERestartLocalTransport!({ delayConsentListener: true })
        )
      ).toBe(true)
      await page.waitForFunction(() => window.__consentListenerGate?.held)
      await beginProbe(page, "e2e-before-mount")
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.__cogniaE2EAutomation!.consentPending()).length)
        )
        .toBe(1)
      await expect(overlay(page)).toBeHidden()
      // The broker outlives this document. The new overlay must recover the
      // already emitted request without an SDK mutation or a second broadcast.
      const pendingIds = await page.evaluate(async () =>
        (await window.__cogniaE2EAutomation!.consentPending()).map((request) => request.id)
      )
      await page.reload()
      await page.waitForFunction(() => Boolean(window.__cogniaE2EAutomation))
      expect(
        await page.evaluate(async () =>
          (await window.__cogniaE2EAutomation!.consentPending()).map((request) => request.id)
        )
      ).toEqual(pendingIds)
      await expect(overlay(page)).toBeVisible()
      await overlay(page)
        .getByRole("button", { name: /^(Allow once|本次允许)$/ })
        .click()
      // The old document's IPC Promise is gone; the native audit is the
      // authoritative completion evidence across this reload.
      await expect
        .poll(() =>
          page.evaluate(
            async (before) =>
              (await window.__cogniaE2EAutomation!.auditSnapshot()).some(
                (entry) =>
                  !before.includes(entry.id) &&
                  entry.command === "click" &&
                  entry.surface === "workflow" &&
                  /stale[_ ]?element/i.test(entry.error ?? "")
              ),
            auditIds
          )
        )
        .toBe(true)
      expect(
        await page.evaluate(
          async () => (await window.__cogniaE2EAutomation!.consentPending()).length
        )
      ).toBe(0)
    } finally {
      await page.evaluate(() => window.__consentListenerGate?.release())
    }
  })

  test("identical independent calls retain separate consent requests", async ({ page }) => {
    await page.evaluate(() => {
      window.__automationConcurrentResults = []
      const api = window.__cogniaE2EAutomation!
      void Promise.allSettled(
        Array.from({ length: 2 }, () =>
          api.click(
            { kind: "element", elementRef: "__e2e_missing_element__" },
            {},
            { surface: "workflow", sessionKey: "e2e-concurrent-identical", forceTier: "perCall" }
          )
        )
      ).then((results) => {
        window.__automationConcurrentResults = results.map((result) =>
          result.status === "fulfilled" ? "unexpected success" : String(result.reason)
        )
      })
    })
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.__cogniaE2EAutomation!.consentPending()).length)
      )
      .toBe(2)
    for (const remaining of [1, 0]) {
      await overlay(page)
        .getByRole("button", { name: /^(Reject|拒绝)$/ })
        .click()
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.__cogniaE2EAutomation!.consentPending()).length)
        )
        .toBe(remaining)
    }
    await expect
      .poll(() => page.evaluate(() => window.__automationConcurrentResults))
      .toEqual([
        expect.stringMatching(/declined|UserDeclined/i),
        expect.stringMatching(/declined|UserDeclined/i),
      ])
  })

  test("Allow once reaches the backend and does not grant the next call", async ({ page }) => {
    await beginProbe(page, "e2e-allow-once")
    await expect(overlay(page)).toBeVisible()
    await overlay(page)
      .getByRole("button", { name: /^(Allow once|本次允许)$/ })
      .click()
    await expectResult(page, /stale[_ ]?element/i)
    await beginProbe(page, "e2e-allow-once")
    await expect(overlay(page)).toBeVisible()
    await overlay(page)
      .getByRole("button", { name: /^(Reject|拒绝)$/ })
      .click()
    await expectResult(page, /declined|UserDeclined/i)
  })

  for (const name of [/^(Reject|拒绝)$/, /^(Close|关闭)$/]) {
    test(`${name.source} denies the pending call`, async ({ page }) => {
      await beginProbe(page, "e2e-deny")
      await expect(overlay(page)).toBeVisible()
      await overlay(page).getByRole("button", { name }).click()
      await expectResult(page, /declined|UserDeclined/i)
      await expect(overlay(page)).toBeHidden()
    })
  }

  test("a timed session grant is scoped to its original session", async ({ page }) => {
    await beginProbe(page, "e2e-granted-session")
    await expect(overlay(page)).toBeVisible()
    await overlay(page)
      .getByRole("button", { name: /^(15 min|15 分钟)$/ })
      .click()
    await expectResult(page, /stale[_ ]?element/i)
    await beginProbe(page, "e2e-granted-session")
    await expectResult(page, /stale[_ ]?element/i)
    await expect(overlay(page)).toBeHidden()
    await beginProbe(page, "e2e-different-session")
    await expect(overlay(page)).toBeVisible()
    await overlay(page)
      .getByRole("button", { name: /^(Reject|拒绝)$/ })
      .click()
    await expectResult(page, /declined|UserDeclined/i)
  })

  test("unanswered prompt times out without reaching the backend", async ({ page }) => {
    await beginProbe(page, "e2e-timeout")
    await expect(overlay(page)).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => window.__automationProbeResult?.error), {
        timeout: MIN_CONSENT_TIMEOUT_MS + 5_000,
      })
      .toMatch(/declined|UserDeclined/i)
    await expect(overlay(page)).toBeHidden()
  })

  test("kill switch refuses approval while a prompt is pending", async ({ page }) => {
    await beginProbe(page, "e2e-kill")
    await expect(overlay(page)).toBeVisible()
    await page.evaluate(() => window.__cogniaE2EAutomation!.killSwitch())
    // Responding after emergency stop must never reach the backend.
    await overlay(page)
      .getByRole("button", { name: /^(Allow once|本次允许)$/ })
      .click()
    await expect
      .poll(() => page.evaluate(() => window.__automationProbeResult?.error), {
        timeout: MIN_CONSENT_TIMEOUT_MS + 5_000,
      })
      .toMatch(/kill switch|kill[_ ]?switch[_ ]?active/i)
    expect(await page.evaluate(() => window.__cogniaE2EAutomation!.killSwitchEngaged())).toBe(true)
  })
})
