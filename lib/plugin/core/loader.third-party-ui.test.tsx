/**
 * @jest-environment jsdom
 *
 * End-to-end proof that a THIRD-PARTY plugin can ship React UI.
 *
 * Every in-tree plugin declares `"main": "src/index.ts"` and is compiled into
 * the app bundle, so none of them exercises the path a real installed plugin
 * takes: esbuild → CJS bundle → `(0, eval)` → host-resolved `require`. That
 * path was broken — the bundle was built with `--external:react` while the
 * loader's `require` threw for every specifier — and a unit test cannot catch
 * it, because the failure only exists at the eval boundary where two React
 * instances would meet.
 *
 * So this suite builds a real bundle with the real bundler using the real
 * externals, runs it through the real loader, and renders the result in the
 * host's React tree.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act, render, screen } from "@testing-library/react"
import { fireEvent } from "@testing-library/dom"

import { PluginLoader } from "./loader"
import { PLUGIN_SHARED_MODULES, __resetSharedModulesForTest } from "./shared-modules"

/** Mirrors `ESBUILD_EXTERNALS` in crates/cognia-cli/src/engine/frontend_build.rs. */
const CLI_EXTERNALS = [
  "@/types/plugin",
  "@/lib/*",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "@cognia/plugin-sdk",
  "@cognia/plugin-ui",
]

const PLUGIN_SOURCE = `
import { useState } from "react"
import { Button, Badge } from "@cognia/plugin-ui"

export function Panel({ motionReduced }) {
  // A hook. With a second bundled React this throws "Invalid hook call" the
  // moment the host renders it.
  const [count, setCount] = useState(0)
  return (
    <div>
      <Badge>{motionReduced ? "still" : "animated"}</Badge>
      <Button onClick={() => setCount((c) => c + 1)}>count:{count}</Button>
    </div>
  )
}

export default { activate() { return {} } }
`

/**
 * Build the fixture the way `cognia plugin build` does — the esbuild binary
 * with the CLI's flags, not the JS API. Two reasons: it is the same code path
 * a plugin author's machine runs, and esbuild's JS API refuses to load under
 * jsdom (its `Uint8Array` invariant fails across jsdom's realm).
 */
function buildThirdPartyBundle(source: string, extraExternals: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "cognia-plugin-"))
  mkdirSync(join(root, "src"), { recursive: true })
  const entry = join(root, "src", "index.jsx")
  writeFileSync(entry, source, "utf8")

  return execFileSync(
    join(process.cwd(), "node_modules", ".bin", "esbuild"),
    [
      entry,
      "--bundle",
      "--format=cjs",
      "--platform=neutral",
      "--target=es2022",
      // The temp dir has no tsconfig, so state the JSX mode the template ships.
      "--jsx=automatic",
      ...[...CLI_EXTERNALS, ...extraExternals].map((e) => `--external:${e}`),
      "--log-level=warning",
    ],
    { encoding: "utf8", cwd: root }
  )
}

let bundle: string

beforeAll(() => {
  bundle = buildThirdPartyBundle(PLUGIN_SOURCE)
}, 30_000)

beforeEach(() => {
  __resetSharedModulesForTest()
})

const originalFetch = globalThis.fetch

afterEach(() => {
  jest.restoreAllMocks()
  globalThis.fetch = originalFetch
})

/**
 * Load the built bundle through the loader's real fetch+eval path. Assigns
 * `fetch` rather than spying on it — this jsdom environment has no `fetch`
 * property to spy on, and the loader's Tauri strategy falls through to a plain
 * fetch of the module path.
 */
async function loadViaLoader(code: string): Promise<Record<string, unknown>> {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => code,
  })) as unknown as typeof fetch
  const loader = new PluginLoader()
  return loader.importEntry("/plugins/demo/dist/index.js")
}

describe("the built bundle", () => {
  it("leaves the host-shared modules it uses external", () => {
    // Only the runtimes actually referenced appear — a production `--jsx=automatic`
    // build emits `react/jsx-runtime` and never the dev variant.
    for (const specifier of ["react", "react/jsx-runtime", "@cognia/plugin-ui"]) {
      expect(PLUGIN_SHARED_MODULES).toContain(specifier)
      expect(bundle).toContain(`require("${specifier}")`)
    }
  })

  it("does not inline a second copy of React", () => {
    // The specific failure this whole feature exists to prevent. React's own
    // source is unmistakable; if it shows up here, hooks are already doomed.
    expect(bundle).not.toContain("react.development.js")
    expect(bundle).not.toContain("Invalid hook call")
    expect(bundle).not.toContain("ReactCurrentDispatcher")
  })

  it("is CommonJS, which is what the loader's eval wrapper expects", () => {
    expect(bundle).toMatch(/module\.exports|exports\./)
    expect(bundle).not.toMatch(/^\s*import\s/m)
  })
})

describe("loading it through the real loader path", () => {
  it("returns the plugin's exports", async () => {
    const exports = await loadViaLoader(bundle)
    expect(typeof exports.Panel).toBe("function")
  })

  it("renders the plugin's component inside the host React tree", async () => {
    const exports = await loadViaLoader(bundle)
    const Panel = exports.Panel as React.ComponentType<{ motionReduced: boolean }>
    render(<Panel motionReduced={false} />)
    expect(screen.getByRole("button", { name: /count:0/ })).toBeInTheDocument()
  })

  it("runs the plugin component's hooks against the host dispatcher", async () => {
    // The decisive assertion. A bundled React would throw on the first
    // useState; a shared one updates state normally.
    const exports = await loadViaLoader(bundle)
    const Panel = exports.Panel as React.ComponentType<{ motionReduced: boolean }>
    render(<Panel motionReduced={false} />)
    const button = screen.getByRole("button", { name: /count:0/ })
    act(() => {
      fireEvent.click(button)
    })
    expect(screen.getByRole("button", { name: /count:1/ })).toBeInTheDocument()
  })

  it("renders host components resolved from @cognia/plugin-ui", async () => {
    const exports = await loadViaLoader(bundle)
    const Panel = exports.Panel as React.ComponentType<{ motionReduced: boolean }>
    render(<Panel motionReduced={false} />)
    // data-slot comes from the host's kit, proving the plugin got the host's
    // component rather than something it bundled itself.
    expect(screen.getByRole("button")).toHaveAttribute("data-slot", "button")
    expect(screen.getByText("animated")).toHaveAttribute("data-slot", "badge")
  })
})

describe("a bundle that reaches for something the host does not share", () => {
  // These model an author who marked a specifier external that the host does
  // not hand out — the only way an unshared `require` can survive bundling.
  it("fails with a diagnostic naming the specifier", async () => {
    const bad = buildThirdPartyBundle(
      `import fs from "node:fs"\nexport default { activate() { return fs } }\n`,
      ["node:fs"]
    )
    await expect(loadViaLoader(bad)).rejects.toThrow(/node:fs/)
  })

  it("rejects react-dom, so a plugin cannot portal out of its slot", async () => {
    const bad = buildThirdPartyBundle(
      `import { createPortal } from "react-dom"\nexport default { activate() { return createPortal } }\n`
    )
    await expect(loadViaLoader(bad)).rejects.toThrow(/not available to plugins/)
  })
})
