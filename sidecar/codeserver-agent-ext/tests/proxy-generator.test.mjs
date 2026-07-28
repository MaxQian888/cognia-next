import assert from "node:assert/strict"
import { test } from "node:test"

import { buildProxyPackageJson, buildProxyVsix, canonicalJson } from "../src/proxy-generator.mjs"

const input = {
  pluginId: "acme.tools",
  pluginVersion: "2.3.4",
  manifestHash: "sha256:manifest",
  catalogHash: "sha256:catalog",
  contributions: {
    commands: [{ command: "cognia.acme.tools.refresh", title: "Refresh" }],
    languages: [{ id: "cognia.acme.tools.acme-template", extensions: [".acme"] }],
  },
  providers: [
    {
      id: "cognia.acme.tools.hover",
      kind: "hover",
      handler: "provideHover",
      permission: "editor:read",
    },
  ],
}

test("buildProxyPackageJson emits a platform-owned extension with no author entrypoint", () => {
  const pkg = buildProxyPackageJson(input)
  assert.equal(pkg.name, "proxy-acme-tools")
  assert.equal(pkg.publisher, "cognia-managed")
  assert.equal(pkg.version, "2.3.4")
  assert.equal(pkg.engines.vscode, "1.128.0")
  assert.equal(pkg.main, "./dist/proxy.js")
  assert.deepEqual(pkg.activationEvents, [
    "onCommand:cognia.acme.tools.refresh",
    "onLanguage:cognia.acme.tools.acme-template",
    "onStartupFinished",
  ])
  assert.deepEqual(pkg.contributes, input.contributions)
  assert.deepEqual(pkg.extensionDependencies, ["cognia.cognia-managed-broker"])
  assert.deepEqual(pkg.cogniaManaged, {
    pluginId: "acme.tools",
    pluginVersion: "2.3.4",
    manifestHash: "sha256:manifest",
    catalogHash: "sha256:catalog",
    platformVersion: "1.0.0",
    providers: input.providers,
    executables: [],
    protocols: { lsp: [], dap: [], mcp: [] },
  })
})

test("canonicalJson is independent of object key insertion order", () => {
  assert.equal(
    canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: [3, 2] }),
    canonicalJson({ a: [3, 2], nested: { a: 1, b: 2 }, z: 1 })
  )
})

test("provider-only proxies receive precise activation events with a safe fallback", () => {
  const pkg = buildProxyPackageJson({
    ...input,
    contributions: {},
    providers: [
      {
        id: "cognia.acme.tools.fs",
        kind: "file-system",
        handler: "fs",
        metadata: { scheme: "cognia.acme.tools.fs" },
      },
      {
        id: "cognia.acme.tools.hover",
        kind: "hover",
        handler: "hover",
        selector: { language: "typescript" },
      },
      {
        id: "cognia.acme.tools.chat",
        kind: "chat-participant",
        handler: "chat",
      },
    ],
  })
  assert.deepEqual(pkg.activationEvents, [
    "onFileSystem:cognia.acme.tools.fs",
    "onLanguage:typescript",
    "onStartupFinished",
  ])
})

test("buildProxyVsix is byte-for-byte deterministic and content addressed", async () => {
  const first = await buildProxyVsix({
    ...input,
    proxyBundle: Buffer.from("exports.activate = () => {};\n"),
    assets: {
      "media/icon.svg": Buffer.from("<svg/>"),
    },
  })
  const second = await buildProxyVsix({
    ...input,
    assets: {
      "media/icon.svg": Buffer.from("<svg/>"),
    },
    proxyBundle: Buffer.from("exports.activate = () => {};\n"),
  })
  assert.deepEqual(first.bytes, second.bytes)
  assert.equal(first.sha256, second.sha256)
  assert.match(first.sha256, /^[a-f0-9]{64}$/)
  assert.equal(first.filename, "cognia-managed.proxy-acme-tools-2.3.4.vsix")
})

test("proxy generation rejects contributions outside the plugin namespace", () => {
  assert.throws(
    () =>
      buildProxyPackageJson({
        ...input,
        contributions: {
          commands: [{ command: "other.plugin.command", title: "Unsafe" }],
        },
      }),
    /IDE_PROXY_ID_OUTSIDE_NAMESPACE/
  )
})
