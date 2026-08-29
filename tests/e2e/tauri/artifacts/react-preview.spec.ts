/**
 * Artifact preview under the PACKAGED desktop CSP (ADR-0158, batch 9).
 *
 * This is the only place the artifact runtime can be checked honestly. The
 * browser, `pnpm dev` and the Capacitor shell ship no CSP at all, and
 * `pnpm tauri dev` serves the page from `localhost:3000` — so all three let a
 * preview shell "work" that the packaged app refuses outright. That ambiguity
 * is what hid the ADR-0076 failure for months, and it is what hid this one: the
 * React shell's `unpkg.com/react@19/umd/*` tags had been a 404 since React 19
 * dropped UMD builds, and even a working CDN would have been blocked here.
 *
 * Measured in a packaged shell and pinned below: an `about:srcdoc` child —
 * sandboxed, opaque origin, whatever meta CSP it carries — INHERITS
 * `src-tauri/tauri.conf.json`'s policy. What still runs inside it is a
 * same-origin `<script src>` and a `blob:` script, and nothing else. Every
 * assertion here is one of the three legs that keeps standing on.
 *
 * Deliberately does NOT drive the artifact panel through the UI: that needs an
 * account, a session and a model round-trip, none of which say anything about
 * the CSP. The frame is built exactly the way `getReactShellHtml` builds it.
 */

import { expect, test } from "../fixtures"

const RUNTIME_BASE = "/artifact-runtime"

test.describe("tauri — artifact runtime under the shell CSP", () => {
  test("@critical the offline runtime is served from the app origin", async ({ page }) => {
    const manifest = await page.evaluate(async (base) => {
      const response = await fetch(`${base}/manifest.json`)
      return response.ok ? await response.json() : null
    }, RUNTIME_BASE)

    // Committed to the repo the way `public/monaco` is, so a fresh clone and an
    // offline machine both have it.
    expect(manifest).not.toBeNull()
    expect(manifest.files["react-runtime.js"]).toBeTruthy()
    expect(manifest.files["artifact-shell.js"]).toBeTruthy()
    expect(manifest.files["jsx-transform.js"]).toBeTruthy()
    expect(String(manifest.reactVersion)).toMatch(/^19\./)
  })

  test("@critical the shell CSP reaches into a sandboxed srcdoc child", async ({ page }) => {
    // The measurement this whole batch turns on. If this ever reports that the
    // policy is NOT inherited, the architecture below is over-built — and if it
    // reports that `'self'` no longer matches, the preview is dead again and
    // only a custom URI scheme can revive it.
    const result = await page.evaluate(
      () =>
        new Promise<{ inlineRan: boolean; externalRan: boolean; inheritedPolicy: string | null }>(
          (resolve) => {
            const state = {
              inlineRan: false,
              externalRan: false,
              inheritedPolicy: null as string | null,
            }
            const frame = document.createElement("iframe")
            frame.setAttribute("sandbox", "allow-scripts allow-same-origin")
            frame.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px"
            frame.srcdoc =
              "<!doctype html><html><head></head><body>" +
              "<script>window.__inline = true<\/script>" +
              "<script src='/artifact-runtime/react-runtime.js'><\/script>" +
              "</body></html>"
            frame.addEventListener("load", () => {
              window.setTimeout(() => {
                const win = frame.contentWindow as
                  (Window & { __inline?: boolean; React?: unknown }) | null
                const doc = frame.contentDocument
                state.inlineRan = win?.__inline === true
                state.externalRan = typeof win?.React !== "undefined"
                doc?.addEventListener("securitypolicyviolation", (event) => {
                  state.inheritedPolicy ??= (event as SecurityPolicyViolationEvent).originalPolicy
                })
                const probe = doc!.createElement("script")
                probe.textContent = "window.__probe = true"
                doc!.body.appendChild(probe)
                window.setTimeout(() => {
                  frame.remove()
                  resolve(state)
                }, 200)
              }, 200)
            })
            document.body.appendChild(frame)
          }
        )
    )

    expect(result.inlineRan).toBe(false)
    expect(result.externalRan).toBe(true)
    expect(result.inheritedPolicy).toContain("script-src")
    // The child is enforcing the SHELL's policy, not one of its own.
    expect(result.inheritedPolicy).toContain("'wasm-unsafe-eval'")
  })

  test("@critical a React artifact renders offline in an opaque-origin frame", async ({ page }) => {
    const result = await page.evaluate(
      (base) =>
        new Promise<{ ready: boolean; rendered: boolean; error: string | null; requests: number }>(
          (resolve) => {
            const state = {
              ready: false,
              rendered: false,
              error: null as string | null,
              requests: 0,
            }
            const performanceBefore = performance.getEntriesByType("resource").length
            const origin = location.origin
            const csp =
              `default-src 'none'; script-src ${origin} blob:; style-src 'unsafe-inline'; ` +
              `img-src data: blob:; font-src data:; connect-src 'none'`
            const frame = document.createElement("iframe")
            // No `allow-same-origin`: the artifact runs with an opaque origin.
            frame.setAttribute("sandbox", "allow-scripts")
            frame.style.cssText = "position:fixed;left:-9999px;width:320px;height:200px"
            frame.srcdoc =
              `<!doctype html><html><head><meta charset="utf-8">` +
              `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
              `<script src="${origin}${base}/react-runtime.js"><\/script>` +
              `<script src="${origin}${base}/artifact-shell.js"><\/script>` +
              `</head><body><div id="root"></div></body></html>`

            window.addEventListener("message", (event) => {
              if (event.source !== frame.contentWindow) return
              const data = event.data as { type?: string; message?: string }
              if (data?.type === "artifact-shell-ready") {
                state.ready = true
                // Already transformed, exactly as the host's Worker hands it over.
                frame.contentWindow?.postMessage(
                  {
                    type: "render-component",
                    isModule: false,
                    code: "function App(){return React.createElement('h3',null,'offline')}",
                  },
                  "*"
                )
              }
              if (data?.type === "artifact-preview-ready") state.rendered = true
              if (data?.type === "artifact-preview-error") state.error = data.message ?? "?"
            })

            document.body.appendChild(frame)
            window.setTimeout(() => {
              state.requests = performance
                .getEntriesByType("resource")
                .slice(performanceBefore)
                .filter((entry) => !entry.name.startsWith(origin)).length
              frame.remove()
              resolve(state)
            }, 4000)
          }
        ),
      RUNTIME_BASE
    )

    expect(result.error).toBeNull()
    expect(result.ready).toBe(true)
    expect(result.rendered).toBe(true)
    // Acceptance: zero external requests. React 19 has no UMD build to fetch,
    // and no CDN is reachable from this policy anyway.
    expect(result.requests).toBe(0)
  })
})
