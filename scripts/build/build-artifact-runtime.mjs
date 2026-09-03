#!/usr/bin/env node
/**
 * Bundle the offline React artifact runtime into `public/artifact-runtime/`
 * so a React artifact preview renders with ZERO network requests.
 *
 * React 19 stopped publishing UMD builds, so the `unpkg.com/react@19/umd/*`
 * tags the preview shell used to carry are a permanent 404 — every React
 * artifact preview fell through to a CDN-timeout notice in every shell. The
 * fix is to ship the runtime ourselves, the same way `public/monaco` ships
 * Monaco: build it here, commit the output, and a fresh clone works offline.
 *
 * Outputs (all committed):
 *   react-runtime.js   IIFE bundle of react + react-dom/client + jsx-runtime,
 *                      built with NODE_ENV=production (the CDN tags pulled the
 *                      DEVELOPMENT builds), exposing globalThis.React /
 *                      globalThis.ReactDOM / globalThis.ReactDOMClient.
 *   jsx-transform.js   @babel/standalone, exposing globalThis.CogniaArtifactJsx
 *                      in a document and answering `postMessage` transform
 *                      requests when loaded as a Worker.
 *   artifact-shell.js  the in-frame bootstrap
 *                      (lib/artifacts/runtime/artifact-shell-entry.ts), shared
 *                      by the React shell and the interactive HTML sandbox. A
 *                      FILE and not an inline script, because a srcdoc child
 *                      inherits the packaged shell's CSP, which has neither
 *                      'unsafe-inline' nor 'unsafe-eval' (ADR-0158).
 *   manifest.json      versions + byte sizes + sha256 of the two bundles.
 *
 * Run before `pnpm dev` / `pnpm build` (wired into predev/prebuild next to
 * copy-monaco-assets.mjs). Shape follows that script deliberately: missing
 * dependencies skip silently, the manifest is the idempotency sentinel, and
 * NOTHING here may fail the build.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const OUT_DIR = path.resolve(ROOT, "public", "artifact-runtime")
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json")

export const REACT_RUNTIME_FILE = "react-runtime.js"
export const JSX_TRANSFORM_FILE = "jsx-transform.js"
export const ARTIFACT_SHELL_FILE = "artifact-shell.js"
export const MANIFEST_FILE = "manifest.json"

/**
 * The shell bundle's own source. It has to be hashed into the manifest because
 * the freshness check otherwise only watches react/babel versions and the
 * OUTPUT hashes, so editing this file left the committed bundle stale and the
 * build cheerfully reported "already fresh". That is not hypothetical: the
 * capture-snapshot handler was written, tested, and silently not shipped.
 */
export const ARTIFACT_SHELL_SOURCE = "lib/artifacts/runtime/artifact-shell-entry.ts"

/**
 * Entry source for the React bundle. `import * as ns` then unwrapping
 * `ns.default` covers both interop shapes — react@19 is CJS, so esbuild hands
 * back a namespace with a `default`, while a future ESM build would not.
 */
export const REACT_RUNTIME_ENTRY = `
import * as ReactNamespace from "react"
import * as ReactDomNamespace from "react-dom"
import * as ReactDomClientNamespace from "react-dom/client"
import * as JsxRuntimeNamespace from "react/jsx-runtime"

const React = ReactNamespace.default ?? ReactNamespace
const ReactDom = ReactDomNamespace.default ?? ReactDomNamespace
const ReactDomClient = ReactDomClientNamespace.default ?? ReactDomClientNamespace
const JsxRuntime = JsxRuntimeNamespace.default ?? JsxRuntimeNamespace

globalThis.React = React
// One object carrying both faces, because artifact code written against the
// old UMD global reaches for ReactDOM.createRoot, which lives in react-dom/client.
globalThis.ReactDOM = Object.assign({}, ReactDom, ReactDomClient)
globalThis.ReactDOMClient = ReactDomClient
globalThis.ReactJSXRuntime = JsxRuntime
globalThis.__COGNIA_ARTIFACT_REACT_VERSION__ = React.version
`

/**
 * Entry source for the JSX transformer. Deliberately dual-context: the same
 * bundle serves the in-frame transform and the parent-page Worker, so the
 * delivery decision does not fork the build.
 */
export const JSX_TRANSFORM_ENTRY = `
import { transform, availablePlugins } from "@babel/standalone"

function looksLikeModule(code) {
  return /^\\s*(?:import|export)[\\s{*]/m.test(code)
}

/**
 * Compile artifact JSX to a classic script. Model-authored React artifacts
 * very often open with \`import React from "react"\`, which is a syntax error
 * under script semantics — so ESM input is downleveled to CommonJS and the
 * shell supplies a \`require\` that hands back the globals.
 */
export function transformArtifactJsx(code) {
  const isModule = looksLikeModule(code)
  const result = transform(code, {
    presets: [["react", { runtime: "classic" }]],
    plugins: isModule ? [availablePlugins["transform-modules-commonjs"]] : [],
    sourceType: isModule ? "module" : "script",
    filename: "artifact.jsx",
    compact: false,
    babelrc: false,
    configFile: false,
  })
  return { code: result.code ?? "", isModule }
}

globalThis.CogniaArtifactJsx = { transform: transformArtifactJsx }

// Worker face: a document has no \`importScripts\`, a worker has no \`document\`.
if (typeof document === "undefined" && typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("message", (event) => {
    const request = event.data
    if (!request || request.type !== "cognia-artifact-jsx-transform") return
    try {
      const { code, isModule } = transformArtifactJsx(String(request.code ?? ""))
      globalThis.postMessage({
        type: "cognia-artifact-jsx-result",
        id: request.id,
        code,
        isModule,
      })
    } catch (error) {
      globalThis.postMessage({
        type: "cognia-artifact-jsx-result",
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}
`

/**
 * Entry for the in-frame bootstrap. The logic lives under `lib/` so it has a
 * co-located unit test; this is only the glue that installs it on the frame.
 */
export const ARTIFACT_SHELL_ENTRY = `
import { installArtifactShellRuntime } from "./lib/artifacts/runtime/artifact-shell-entry"

installArtifactShellRuntime(globalThis)
`

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

/**
 * The manifest doubles as the freshness sentinel: a rebuild is only needed
 * when a dependency version moved or an output went missing/edited.
 */
export function isManifestFresh(manifest, expected, readFile) {
  if (!manifest || typeof manifest !== "object") return false
  if (manifest.schema !== expected.schema) return false
  if (manifest.reactVersion !== expected.reactVersion) return false
  if (manifest.babelVersion !== expected.babelVersion) return false
  if (manifest.shellEntrySha !== expected.shellEntrySha) return false
  const files = manifest.files
  if (!files || typeof files !== "object") return false
  for (const name of [REACT_RUNTIME_FILE, JSX_TRANSFORM_FILE, ARTIFACT_SHELL_FILE]) {
    const entry = files[name]
    if (!entry || typeof entry.sha256 !== "string" || typeof entry.bytes !== "number") return false
    const bytes = readFile(name)
    if (!bytes) return false
    if (bytes.length !== entry.bytes) return false
    if (sha256(bytes) !== entry.sha256) return false
  }
  return true
}

export function buildManifest({ reactVersion, babelVersion, shellEntrySha, outputs }) {
  const files = {}
  for (const [name, bytes] of Object.entries(outputs)) {
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) }
  }
  return { schema: 1, reactVersion, babelVersion, shellEntrySha, files }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function readOutput(name) {
  try {
    return fs.readFileSync(path.join(OUT_DIR, name))
  } catch {
    return null
  }
}

async function main() {
  const reactPkg = readJson(path.resolve(ROOT, "node_modules", "react", "package.json"))
  const babelPkg = readJson(
    path.resolve(ROOT, "node_modules", "@babel", "standalone", "package.json")
  )
  if (!reactPkg || !babelPkg) {
    console.log("[artifact-runtime] skip: react / @babel/standalone not installed")
    return
  }

  let shellEntrySha
  try {
    shellEntrySha = sha256(fs.readFileSync(path.resolve(ROOT, ARTIFACT_SHELL_SOURCE)))
  } catch {
    console.log("[artifact-runtime] skip: shell entry source missing")
    return
  }
  const expected = {
    schema: 1,
    reactVersion: reactPkg.version,
    babelVersion: babelPkg.version,
    shellEntrySha,
  }
  if (isManifestFresh(readJson(MANIFEST_PATH), expected, readOutput)) {
    console.log(`[artifact-runtime] skip: ${OUT_DIR} already fresh`)
    return
  }

  let esbuild
  try {
    esbuild = await import("esbuild")
  } catch {
    console.log("[artifact-runtime] skip: esbuild not installed")
    return
  }

  const bundle = async (contents, loader = "js") => {
    const result = await esbuild.build({
      stdin: { contents, resolveDir: ROOT, loader, sourcefile: `artifact-runtime-entry.${loader}` },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      minify: true,
      legalComments: "none",
      // The CDN tags loaded react.development.js; the production define is
      // what turns this into the build a preview should actually run.
      define: { "process.env.NODE_ENV": '"production"' },
      write: false,
    })
    return Buffer.from(result.outputFiles[0].contents)
  }

  const outputs = {
    [REACT_RUNTIME_FILE]: await bundle(REACT_RUNTIME_ENTRY),
    [JSX_TRANSFORM_FILE]: await bundle(JSX_TRANSFORM_ENTRY),
    [ARTIFACT_SHELL_FILE]: await bundle(ARTIFACT_SHELL_ENTRY, "ts"),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  for (const [name, bytes] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(OUT_DIR, name), bytes)
  }
  const manifest = buildManifest({ ...expected, outputs })
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

  for (const [name, bytes] of Object.entries(outputs)) {
    console.log(`[artifact-runtime] ${name}: ${(bytes.length / 1024).toFixed(0)} KB`)
  }
  console.log("[artifact-runtime] done")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never fail the build — the loader falls back and logs the downgrade.
    console.log(`[artifact-runtime] skip: ${error instanceof Error ? error.message : error}`)
    process.exit(0)
  })
}
