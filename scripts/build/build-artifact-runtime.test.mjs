import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

import {
  JSX_TRANSFORM_ENTRY,
  JSX_TRANSFORM_FILE,
  ARTIFACT_SHELL_FILE,
  REACT_RUNTIME_ENTRY,
  REACT_RUNTIME_FILE,
  buildManifest,
  isManifestFresh,
  sha256,
} from "./build-artifact-runtime.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const OUT_DIR = path.join(ROOT, "public", "artifact-runtime")

function readOutput(name) {
  try {
    return fs.readFileSync(path.join(OUT_DIR, name))
  } catch {
    return null
  }
}

test("the react entry exposes the globals a preview shell reaches for", () => {
  for (const global of ["globalThis.React", "globalThis.ReactDOM", "globalThis.ReactDOMClient"]) {
    assert.ok(REACT_RUNTIME_ENTRY.includes(global), `${global} missing`)
  }
  // react-dom/client is where createRoot lives in 19; merging it into the
  // ReactDOM global is what keeps UMD-era artifact code working.
  assert.ok(REACT_RUNTIME_ENTRY.includes('import * as ReactDomClientNamespace from "react-dom/client"'))
})

test("the jsx entry answers worker messages and exposes a document-side global", () => {
  assert.ok(JSX_TRANSFORM_ENTRY.includes("globalThis.CogniaArtifactJsx"))
  assert.ok(JSX_TRANSFORM_ENTRY.includes("cognia-artifact-jsx-transform"))
  assert.ok(JSX_TRANSFORM_ENTRY.includes("cognia-artifact-jsx-result"))
})

test("buildManifest records byte length and digest per file", () => {
  const outputs = { "a.js": Buffer.from("alpha"), "b.js": Buffer.from("beta") }
  const manifest = buildManifest({ reactVersion: "19.2.8", babelVersion: "8.0.4", outputs })
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.files["a.js"].bytes, 5)
  assert.equal(manifest.files["a.js"].sha256, sha256(Buffer.from("alpha")))
})

test("isManifestFresh rejects a version bump, a missing file, and a tampered file", () => {
  const react = Buffer.from("react-bundle")
  const jsx = Buffer.from("jsx-bundle")
  const shell = Buffer.from("shell-bundle")
  const expected = { schema: 1, reactVersion: "19.2.8", babelVersion: "8.0.4" }
  const manifest = buildManifest({
    ...expected,
    outputs: {
      [REACT_RUNTIME_FILE]: react,
      [JSX_TRANSFORM_FILE]: jsx,
      [ARTIFACT_SHELL_FILE]: shell,
    },
  })
  const files = { [REACT_RUNTIME_FILE]: react, [JSX_TRANSFORM_FILE]: jsx, [ARTIFACT_SHELL_FILE]: shell }
  const present = (name) => files[name] ?? null

  assert.equal(isManifestFresh(manifest, expected, present), true)
  assert.equal(
    isManifestFresh(manifest, { ...expected, reactVersion: "19.3.0" }, present),
    false,
    "a react bump must rebuild"
  )
  assert.equal(
    isManifestFresh(manifest, { ...expected, babelVersion: "8.1.0" }, present),
    false,
    "a babel bump must rebuild"
  )
  assert.equal(
    isManifestFresh(manifest, expected, (name) => (name === REACT_RUNTIME_FILE ? null : files[name])),
    false,
    "a deleted output must rebuild"
  )
  assert.equal(
    isManifestFresh(manifest, expected, (name) =>
      name === REACT_RUNTIME_FILE ? Buffer.from("react-bundleX") : files[name]
    ),
    false,
    "an edited output must rebuild"
  )
  assert.equal(isManifestFresh(null, expected, present), false)
  assert.equal(isManifestFresh({ schema: 2 }, expected, present), false)
})

test("the committed jsx bundle transforms JSX and downlevels ESM artifact code", (t) => {
  const bundle = readOutput(JSX_TRANSFORM_FILE)
  if (!bundle) return t.skip("public/artifact-runtime not built")
  const sandbox = { console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(bundle.toString("utf8"), sandbox, { filename: JSX_TRANSFORM_FILE })

  const classic = sandbox.CogniaArtifactJsx.transform("const App = () => <div className='x'>hi</div>")
  assert.equal(classic.isModule, false)
  assert.ok(classic.code.includes("React.createElement"))
  assert.ok(!classic.code.includes("<div"))

  const esm = sandbox.CogniaArtifactJsx.transform(
    'import React from "react"\nexport default function App() { return <p>hi</p> }'
  )
  assert.equal(esm.isModule, true)
  // Downleveled to CommonJS so the shell's `require` shim can feed it the
  // globals — an ESM `import` is a syntax error under script semantics.
  assert.ok(esm.code.includes("require("))
  assert.ok(esm.code.includes("exports"))
})

test("the committed react bundle is a production build exposing the runtime globals", (t) => {
  const bundle = readOutput(REACT_RUNTIME_FILE)
  if (!bundle) return t.skip("public/artifact-runtime not built")
  const source = bundle.toString("utf8")
  // The CDN tags this replaced pulled react.development.js on every preview.
  assert.ok(!source.includes("react-dom.development"))
  assert.ok(source.length < 1_000_000, "react runtime should stay well under 1 MB")

  const sandbox = { console, setTimeout, clearTimeout, queueMicrotask, performance, navigator: {} }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: REACT_RUNTIME_FILE })
  assert.equal(typeof sandbox.React.createElement, "function")
  assert.equal(typeof sandbox.ReactDOM.createRoot, "function")
  assert.equal(typeof sandbox.ReactDOMClient.createRoot, "function")
  assert.ok(sandbox.__COGNIA_ARTIFACT_REACT_VERSION__.startsWith("19."))
})

test("the committed shell bundle carries no eval and installs itself", (t) => {
  const bundle = readOutput(ARTIFACT_SHELL_FILE)
  if (!bundle) return t.skip("public/artifact-runtime not built")
  const source = bundle.toString("utf8")
  // The frame's policy grants blob: and a same-origin URL. Nothing else.
  assert.ok(!/\beval\(/.test(source))
  assert.ok(!source.includes("new Function"))
  assert.ok(source.includes("createObjectURL"))
  assert.ok(source.includes("artifact-shell-ready"))
})
