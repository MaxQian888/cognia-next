/**
 * Playwright helper: seed canonical workflow fixtures via the dev-only
 * `window.__cogniaSeedWorkflow` bridge. Returns the seeded workflow's id so
 * the caller can navigate to `/workflows/editor?id=${id}` directly.
 *
 * The full set of seed kinds lives in `lib/dev/workflow-fixtures.ts` — one
 * fixture per node family so per-family E2E specs can `seedAndOpenWorkflow`
 * without rebuilding the graph in spec code.
 */

import { expect, type Page } from "@playwright/test"
import { waitForTestGlobals } from "./db-reset"
import type { SeededWorkflowKind } from "@/lib/dev/workflow-fixtures"

export type { SeededWorkflowKind }

declare global {
  interface Window {
    __cogniaSeedWorkflow?: (kind: SeededWorkflowKind) => Promise<string>
    __cogniaSeedCharacter?: (draft: {
      name: string
      role?: string
      systemPrompt?: string
    }) => Promise<string>
    __cogniaSeedTeam?: (draft: { name: string; description?: string }) => Promise<string>
    __cogniaSeedSkill?: (draft: {
      name: string
      trigger?: string
      body?: string
    }) => Promise<string>
    __cogniaSeedConnectorDraft?: (draft: {
      adapterId: string
      conversationKey: string
      content: string
    }) => Promise<string>
    __cogniaSeedRun?: (
      workflowId: string,
      status?: "succeeded" | "failed" | "running"
    ) => Promise<string>
    __cogniaSetMockBaseUrls?: (urls: {
      anthropic?: string
      github?: string
      lark?: string
      vectorDb?: string
    }) => Promise<void>
  }
}

export async function seedWorkflow(page: Page, kind: SeededWorkflowKind): Promise<string> {
  await waitForTestGlobals(page)
  const id = await page.evaluate(async (k) => {
    const w = window as Window & {
      __cogniaSeedWorkflow?: (kind: string) => Promise<string>
    }
    if (typeof w.__cogniaSeedWorkflow !== "function") {
      throw new Error("window.__cogniaSeedWorkflow is not wired")
    }
    return w.__cogniaSeedWorkflow(k)
  }, kind)
  expect(id, `seedWorkflow(${kind}) returned a workflow id`).toBeTruthy()
  return id
}

/**
 * Convenience: navigate directly to the seeded workflow's editor route.
 * Returns the seeded id so assertions can match against it.
 */
export async function seedAndOpenWorkflow(page: Page, kind: SeededWorkflowKind): Promise<string> {
  const id = await seedWorkflow(page, kind)
  await page.goto(`/workflows/editor?id=${id}`, { waitUntil: "domcontentloaded" })
  return id
}

export async function seedCharacter(
  page: Page,
  draft: { name: string; role?: string; systemPrompt?: string }
): Promise<string> {
  await waitForTestGlobals(page)
  return page.evaluate(async (d) => (window as Window).__cogniaSeedCharacter!(d), draft)
}

export async function seedTeam(
  page: Page,
  draft: { name: string; description?: string }
): Promise<string> {
  await waitForTestGlobals(page)
  return page.evaluate(async (d) => (window as Window).__cogniaSeedTeam!(d), draft)
}

export async function seedSkill(
  page: Page,
  draft: { name: string; trigger?: string; body?: string }
): Promise<string> {
  await waitForTestGlobals(page)
  return page.evaluate(async (d) => (window as Window).__cogniaSeedSkill!(d), draft)
}

export async function seedConnectorDraft(
  page: Page,
  draft: { adapterId: string; conversationKey: string; content: string }
): Promise<string> {
  await waitForTestGlobals(page)
  return page.evaluate(async (d) => (window as Window).__cogniaSeedConnectorDraft!(d), draft)
}

export async function seedRun(
  page: Page,
  workflowId: string,
  status: "succeeded" | "failed" | "running" = "succeeded"
): Promise<string> {
  await waitForTestGlobals(page)
  return page.evaluate(async ({ id, st }) => (window as Window).__cogniaSeedRun!(id, st), {
    id: workflowId,
    st: status,
  })
}

/**
 * Configure the runtime-side mock base URLs used by AI / GitHub / Lark /
 * vector-DB executors. Specs that don't care about runtime execution can
 * skip this; specs that exercise the executors call it once in beforeEach
 * after `resetCogniaDb`.
 */
export async function configureMockBaseUrls(
  page: Page,
  urls: { anthropic?: string; github?: string; lark?: string; vectorDb?: string }
): Promise<void> {
  await waitForTestGlobals(page)
  await page.evaluate(async (u) => (window as Window).__cogniaSetMockBaseUrls!(u), urls)
}
