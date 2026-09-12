import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

import {
  ARTIFACT_SHELL_FILE,
  ARTIFACT_SHELL_SOURCE,
  JSX_TRANSFORM_ENTRY,
  JSX_TRANSFORM_FILE,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  REACT_RUNTIME_ENTRY,
  REACT_RUNTIME_FILE,
  buildManifest,
  hashSources,
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

function readJsonOutput(name) {
  const bytes = readOutput(name)
  if (!bytes) return null
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    return null
  }
}

/** Read a repo-relative source, for checking the committed manifest. */
function readRepoFile(rel) {
  try {
    return fs.readFileSync(path.resolve(ROOT, rel))
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
  assert.equal(manifest.schema, MANIFEST_SCHEMA)
  assert.equal(manifest.files["a.js"].bytes, 5)
  assert.equal(manifest.files["a.js"].sha256, sha256(Buffer.from("alpha")))
})

test("isManifestFresh rejects a version bump, a missing file, and a tampered file", () => {
  const react = Buffer.from("react-bundle")
  const jsx = Buffer.from("jsx-bundle")
  const shell = Buffer.from("shell-bundle")
  const sources = {
    "lib/artifacts/runtime/artifact-shell-entry.ts": Buffer.from("entry"),
    "lib/artifacts/runtime/element-pick.ts": Buffer.from("picker"),
  }
  const readSource = (rel) => sources[rel] ?? null
  const expected = { reactVersion: "19.2.8", babelVersion: "8.0.4", readSource }
  const manifest = buildManifest({
    reactVersion: "19.2.8",
    babelVersion: "8.0.4",
    shellSources: hashSources(Object.keys(sources), readSource),
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
  assert.equal(
    isManifestFresh(
      manifest,
      { ...expected, readSource: (rel) => (rel.endsWith("artifact-shell-entry.ts") ? Buffer.from("edited") : readSource(rel)) },
      present
    ),
    false,
    "an edited shell entry source must rebuild"
  )
  // The regression the single-file sentinel could not see: the shell imports
  // element-pick.ts, so editing THAT must rebuild too.
  assert.equal(
    isManifestFresh(
      manifest,
      { ...expected, readSource: (rel) => (rel.endsWith("element-pick.ts") ? Buffer.from("edited") : readSource(rel)) },
      present
    ),
    false,
    "an edited transitive shell source must rebuild"
  )
  assert.equal(
    isManifestFresh(manifest, { ...expected, readSource: () => null }, present),
    false,
    "a deleted shell source must rebuild"
  )
  assert.equal(isManifestFresh(null, expected, present), false)
  assert.equal(
    isManifestFresh({ ...manifest, schema: 1 }, expected, present),
    false,
    "a manifest from the single-file sentinel scheme must rebuild once"
  )
  assert.equal(
    isManifestFresh({ ...manifest, shellSources: {} }, expected, present),
    false,
    "an empty source set is never fresh — it would watch nothing"
  )
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

test("buildManifest records every shell source, not just the entry", () => {
  // The sentinel used to watch only dependency versions and OUTPUT hashes, so
  // editing lib/artifacts/runtime/artifact-shell-entry.ts left the committed
  // bundle stale while the build reported "already fresh". Hashing that ONE
  // file fixed the instance and kept the shape of the bug: the moment the
  // shell imported a second module, the same staleness returned. The manifest
  // now carries the whole input set esbuild reported.
  const sources = { "a.ts": Buffer.from("alpha"), "b.ts": Buffer.from("beta") }
  const manifest = buildManifest({
    reactVersion: "19.2.8",
    babelVersion: "8.0.4",
    shellSources: hashSources(Object.keys(sources), (rel) => sources[rel] ?? null),
    outputs: { [ARTIFACT_SHELL_FILE]: Buffer.from("shell") },
  })
  assert.deepEqual(Object.keys(manifest.shellSources), ["a.ts", "b.ts"])
  assert.equal(manifest.shellSources["a.ts"], sha256(Buffer.from("alpha")))
})

test("hashSources marks a vanished source null so it can never match", () => {
  const hashed = hashSources(["gone.ts"], () => null)
  assert.equal(hashed["gone.ts"], null)
})

test("the committed manifest lists the real shell input set", (t) => {
  const manifest = readJsonOutput(MANIFEST_FILE)
  if (!manifest) return t.skip("public/artifact-runtime not built")
  assert.equal(manifest.schema, MANIFEST_SCHEMA)
  const recorded = Object.keys(manifest.shellSources ?? {})
  assert.ok(
    recorded.includes(ARTIFACT_SHELL_SOURCE),
    "the entry itself must be watched"
  )
  // Every recorded source must still hash as recorded, or the committed bundle
  // is stale — which is exactly the condition this file exists to catch.
  for (const rel of recorded) {
    const bytes = readRepoFile(rel)
    assert.ok(bytes, `${rel} is recorded but missing`)
    assert.equal(sha256(bytes), manifest.shellSources[rel], `${rel} changed without a rebuild`)
  }
})
