/**
 * Spec-side access to the shared MockGithubServer's capture log.
 *
 * The instance is booted once in the Playwright globalSetup process and only
 * its base URL crosses the process boundary (E2E_GITHUB_BASE_URL), so specs
 * read captures over HTTP via GET /__control/calls. There is deliberately no
 * reset: the log is shared by fullyParallel workers — match on your own
 * method/path/body instead of assuming a clean slate.
 */

import { expect, type Page } from "@playwright/test"

export interface GithubCapturedCall {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

function githubMockBaseUrl(): string {
  const baseUrl = process.env.E2E_GITHUB_BASE_URL
  if (!baseUrl) {
    throw new Error("E2E_GITHUB_BASE_URL not published — global-setup didn't boot the github mock")
  }
  return baseUrl
}

/**
 * Register the fixtures' repo ("owner/repo") in the github-delivery plugin's
 * repo registry so `buildOctokit` resolves a PAT credential.
 *
 * Two things this guards: (1) the registry lookup — an unregistered repo
 * makes every github executor throw "repo … is not registered"; (2) plugin
 * READINESS — the registry lives in the plugin's dynamically-bumped Dexie
 * table (`github-delivery:repos`), so polling for the store to exist also
 * waits out plugin activation. Without that wait a run triggered early can
 * phantom-succeed before the real executors are even registered.
 *
 * Raw IndexedDB (not import("@/…"), which can't resolve inside evaluate).
 */
export async function registerGithubMockRepo(page: Page, fullName = "owner/repo"): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          async () =>
            await new Promise<boolean>((resolve) => {
              const req = indexedDB.open("cognia-claude")
              req.onerror = () => resolve(false)
              req.onsuccess = () => {
                const db = req.result
                db.onversionchange = () => db.close()
                const has = db.objectStoreNames.contains("github-delivery:repos")
                db.close()
                resolve(has)
              }
            })
        ),
      { timeout: 60_000, message: "github-delivery plugin tables never appeared" }
    )
    .toBe(true)

  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("cognia-claude")
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => db.close()
        const tx = db.transaction("github-delivery:repos", "readwrite")
        tx.objectStore("github-delivery:repos").put({
          fullName: name,
          credentialMode: "pat",
          patToken: "e2e-test-pat",
          pushTarget: { kind: "source-branch" },
          worktreeMode: "local",
          triggerMode: "polling",
        })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => {
          db.close()
          reject(tx.error)
        }
      }
    })
  }, fullName)
}

export async function readGithubCalls(): Promise<GithubCapturedCall[]> {
  const res = await fetch(`${githubMockBaseUrl()}/__control/calls`)
  if (!res.ok) throw new Error(`github mock /__control/calls returned ${res.status}`)
  return (await res.json()) as GithubCapturedCall[]
}

/**
 * Poll the capture log until a call matching method+path arrives, then
 * assert its body contains `bodyMatch` (toMatchObject semantics). Returns
 * the matched call for any extra assertions.
 */
export async function expectGithubCall(opts: {
  method: string
  path: string
  bodyMatch?: Record<string, unknown>
  timeoutMs?: number
}): Promise<GithubCapturedCall> {
  const { method, path, bodyMatch, timeoutMs = 15_000 } = opts
  const deadline = Date.now() + timeoutMs
  let matches: GithubCapturedCall[] = []
  for (;;) {
    matches = (await readGithubCalls()).filter((c) => c.method === method && c.path === path)
    if (matches.length > 0 || Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 250))
  }
  expect(
    matches.length,
    `expected the workflow run to have sent ${method} ${path} to the github mock`
  ).toBeGreaterThan(0)
  const call = matches[matches.length - 1]
  if (bodyMatch) {
    expect(call.body, `${method} ${path} payload`).toMatchObject(bodyMatch)
  }
  return call
}
