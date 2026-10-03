import { test } from "node:test"
import assert from "node:assert/strict"
import Module from "node:module"

const {
  createExtensionResolver,
  installRequireHook,
  setExtensionResolver,
  setGrantedModules,
  uninstallRequireHook,
} = await import("../dist/require-hook.js")

function taggedParent(extensionId) {
  const parent = new Module(`/tmp/${extensionId}/extension.js`)
  parent.cogniaExtensionId = extensionId
  return parent
}

test("sensitive CommonJS imports fail closed without blocking the event loop", () => {
  setExtensionResolver((parent) => parent?.cogniaExtensionId ?? null)
  installRequireHook()
  try {
    const startedAt = Date.now()
    assert.throws(
      () => Module._load("fs", taggedParent("publisher.denied"), false),
      (error) => error?.code === "EPERM"
    )
    assert.ok(Date.now() - startedAt < 100, "denial must be synchronous, not a 30s timeout")
  } finally {
    uninstallRequireHook()
  }
})

test("pre-authorized sensitive modules load synchronously and remain extension-scoped", () => {
  setExtensionResolver((parent) => parent?.cogniaExtensionId ?? null)
  setGrantedModules("publisher.allowed", ["fs"])
  installRequireHook()
  try {
    assert.equal(
      typeof Module._load("fs", taggedParent("publisher.allowed"), false).readFile,
      "function"
    )
    assert.throws(
      () => Module._load("fs", taggedParent("publisher.other"), false),
      (error) => error?.code === "EPERM"
    )
  } finally {
    uninstallRequireHook()
  }
})

test("requires are attributed by where the requiring module lives, failing closed", () => {
  const roots = new Map([
    ["/data/vscode-extensions/acme.tools", "acme.tools"],
    ["/data/vscode-extensions/acme.tools/vendor/inner", "acme.inner"],
  ])
  const dedicated = createExtensionResolver({
    hostRoot: "/app/sidecar/vscode-ext-host",
    roots,
    dedicatedExtensionId: "acme.tools",
  })
  const from = (filename) => ({ filename })
  assert.equal(dedicated(from("/data/vscode-extensions/acme.tools/out/main.js")), "acme.tools")
  assert.equal(
    dedicated(from("/data/vscode-extensions/acme.tools/vendor/inner/x.js")),
    "acme.inner",
    "the longest root wins"
  )
  assert.equal(
    dedicated(from("/app/sidecar/vscode-ext-host/dist/lsp-service.js")),
    null,
    "the host's own code is not an extension's"
  )
  assert.equal(
    dedicated(from("/data/vscode-extensions/acme.toolsmith/x.js")),
    "acme.tools",
    "a sibling folder sharing a prefix is not inside the root; in a dedicated process it is still the extension"
  )
  assert.equal(dedicated(null), "acme.tools", "no parent at all fails closed to the extension")
  const shared = createExtensionResolver({
    hostRoot: "/app/sidecar/vscode-ext-host",
    roots,
    dedicatedExtensionId: null,
  })
  assert.equal(shared(from("/elsewhere/x.js")), null)
  assert.equal(shared(from("/data/vscode-extensions/acme.tools/a.js")), "acme.tools")
})
