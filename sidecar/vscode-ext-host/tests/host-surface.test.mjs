// The window's focus and theme, the fixed `env` values, the value types, and
// API Cognia does not provide, through the real host.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.surface-extension"
const PATH = join(FIXTURES, "surface-extension")

async function until(check, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function startSurface(describe) {
  const commands = new Map()
  const requests = []
  const host = startHost(ID, (method, params) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    if (method === "window:describeEnvironment") return describe()
    return null
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command) =>
    host.request("extension:call", { extensionId: ID, token: commands.get(command), payload: [] })
  return { host, run, requests }
}

test("the window's focus and theme are known at activation and follow the renderer", async () => {
  const { host, run, requests } = await startSurface(() => ({
    focused: false,
    active: false,
    colorThemeKind: 1,
  }))
  try {
    assert.deepEqual(await run("surfaceFixture.activation"), {
      state: { focused: false, active: false },
      theme: 1,
    })
    assert.equal(
      requests.filter((entry) => entry.method === "window:describeEnvironment").length,
      1
    )
    await host.request("window:environmentChanged", {
      focused: true,
      active: true,
      colorThemeKind: 2,
    })
    assert.deepEqual(await run("surfaceFixture.changes"), {
      states: [{ focused: true, active: true }],
      themes: [2],
    })
  } finally {
    host.stop()
  }
})

test("a renderer that cannot describe the window still lets extensions activate", async () => {
  const { host, run } = await startSurface(() => {
    throw new Error("unknown method")
  })
  try {
    assert.deepEqual(await run("surfaceFixture.activation"), {
      state: { focused: true, active: true },
      theme: 2,
    })
    await until(
      () =>
        host.stderr.some((line) => line.includes("could not read the window's focus and theme")),
      "the warning"
    )
  } finally {
    host.stop()
  }
})

test("unsupported API is reported to the renderer and refuses with its reason", async () => {
  const { host, run, requests } = await startSurface(() => null)
  try {
    const reported = await until(
      () => requests.find((entry) => entry.method === "vscode:unsupportedApi"),
      "the report"
    )
    assert.deepEqual(reported.params, { extensionId: ID, api: "window.registerTreeDataProvider" })
    assert.deepEqual(await run("surfaceFixture.saveAs"), {
      error:
        "vscode.workspace.saveAs is not supported in Cognia: Cognia does not let extensions save a document under a new name.",
      notSupported: true,
    })
  } finally {
    host.stop()
  }
})

test("env's fixed values and the task types", async () => {
  const { host, run } = await startSurface(() => null)
  try {
    assert.deepEqual(await run("surfaceFixture.env"), {
      uiKind: 1,
      remoteName: null,
      logLevel: 3,
      shell: "string",
      appRoot: "string",
    })
    assert.deepEqual(await run("surfaceFixture.task"), {
      name: "build",
      group: "build",
      matchers: ["$gcc"],
    })
  } finally {
    host.stop()
  }
})
