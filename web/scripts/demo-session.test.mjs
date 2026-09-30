import assert from "node:assert/strict"
import test from "node:test"

import {
  CHAT_SURFACE_SELECTOR,
  DEMO_ACCOUNT_ID,
  DEV_CHROME_CSS,
  demoAccountName,
  demoSettings,
  productLocale,
} from "./demo-session.mjs"

test("website locales map onto the product's locale ids", () => {
  assert.equal(productLocale("en"), "en")
  assert.equal(productLocale("zh"), "zh-CN")
  assert.throws(() => productLocale("fr"), /unsupported locale fr/)
})

test("a demo session sets locale, theme and finished onboarding, and nothing else", () => {
  assert.deepEqual(demoSettings("zh", "dark"), {
    language: "zh-CN",
    theme: "dark",
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-01T00:00:00.000Z" },
  })
})

test("dev chrome hiding covers the Next.js portal and the perf HUD only", () => {
  assert.match(DEV_CHROME_CSS, /nextjs-portal/)
  assert.match(DEV_CHROME_CSS, /\[data-testid="perf-hud"\]/)
  assert.match(DEV_CHROME_CSS, /display: none !important/)
})

test("the camera frames the chat surface slot", () => {
  assert.equal(CHAT_SURFACE_SELECTOR, '[data-slot="chat-surface-stage"]')
})

test("the demo account is named as a demo, in the film's language", () => {
  assert.equal(demoAccountName("en"), "Demo")
  assert.equal(demoAccountName("zh"), "演示")
  assert.throws(() => demoAccountName("fr"), /unsupported locale fr/)
  assert.match(DEMO_ACCOUNT_ID, /^acct_demo_/)
})
