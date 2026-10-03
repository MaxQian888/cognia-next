// `vscode.workspace`'s folders and files through the real host: the test
// plays the renderer, which reports folders, authorizes file access and
// runs searches and watches.
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.workspace-extension"
const PATH = join(FIXTURES, "workspace-extension")

async function startWorkspace({ folder, granted = ["read", "write"] }) {
  const commands = new Map()
  const requests = []
  const host = startHost(ID, (method, params) => {
    requests.push({ method, params })
    switch (method) {
      case "commands:register":
        commands.set(params.command, params.token)
        return { registered: true }
      case "fs:authorize":
        // The renderer's answer: the folder, when the path is in it and allowed.
        if (!granted.includes(params.access)) {
          throw new Error(`requires permission filesystem:${params.access}`)
        }
        if (!params.path.startsWith(`${folder}/`) && params.path !== folder) {
          throw new Error(`${params.path} is not inside an open workspace folder`)
        }
        return { root: folder }
      case "workspace:findFiles":
        return ["file:///repo/src/a.ts", "file:///repo/src/b/c.ts"]
      case "workspace:createFileSystemWatcher":
        return { watching: true }
      default:
        return null
    }
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [],
  })
  await host.request("workspace:foldersChanged", {
    folders: [{ uri: `file://${folder}`, name: "proj" }],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command, ...args) =>
    host.request("extension:call", { extensionId: ID, token: commands.get(command), payload: args })
  return { host, run, requests }
}

test("folders: names, lookups, relative paths and change events", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ws-folders-")))
  const { host, run } = await startWorkspace({ folder })
  try {
    assert.deepEqual(await run("workspaceFixture.folders", `${folder}/src/a.ts`), {
      names: ["proj"],
      name: "proj",
      rootPath: folder,
      folderOf: "proj",
      relative: "src/a.ts",
      relativeUri: "proj/src/a.ts",
      outside: "/elsewhere/x.ts",
      updated: false,
      events: [],
    })
    await host.request("workspace:foldersChanged", {
      folders: [
        { uri: `file://${folder}`, name: "proj" },
        { uri: "file:///second", name: "second" },
      ],
    })
    await host.request("workspace:foldersChanged", {
      folders: [{ uri: "file:///second", name: "second" }],
    })
    const after = await run("workspaceFixture.folders", "/second/x.ts")
    assert.equal(after.relative, "x.ts")
    assert.deepEqual(after.events, [
      { added: ["second"], removed: [] },
      { added: [], removed: ["proj"] },
    ])
    await host.request("workspace:foldersChanged", { folders: [] })
    const none = await run("workspaceFixture.folders", "/second/x.ts")
    assert.equal(none.name, undefined)
    assert.deepEqual(none.names, [])
  } finally {
    host.stop()
  }
})

test("workspace.fs works on real files once the renderer allows it", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ws-fs-")))
  const { host, run, requests } = await startWorkspace({ folder })
  try {
    const result = await run("workspaceFixture.fs", folder)
    assert.deepEqual(result.bytes, [0, 255, 1])
    assert.equal(result.isUint8Array, true)
    assert.deepEqual(result.stat, { type: 1, size: 3, hasTimes: true })
    assert.equal(result.copyAgain.code, "FileExists")
    assert.deepEqual(result.listing, [
      ["bin.dat", 1],
      ["deeper", 2],
      ["renamed.dat", 1],
    ])
    assert.equal(result.missing.code, "FileNotFound")
    assert.equal(result.trash.code, "Unavailable")
    assert.equal(result.outside.code, "NoPermissions")
    assert.match(result.outside.message, /not inside an open workspace folder/)
    assert.equal(result.scheme.code, "Unavailable")
    assert.deepEqual(result.own, [123, 125])
    assert.equal(result.writable, true)
    // The extension's own storage never asked the renderer.
    const asked = requests.filter((entry) => entry.method === "fs:authorize")
    assert.ok(
      asked.every(
        (entry) => entry.params.path.startsWith(folder) || entry.params.path === "/etc/hosts"
      )
    )
  } finally {
    host.stop()
  }
})

test("workspace.fs refuses writes without permission and links that lead out", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ws-escape-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ws-outside-")))
  writeFileSync(join(outside, "secret.txt"), "s")
  symlinkSync(outside, join(folder, "link"))
  const { host, run } = await startWorkspace({ folder, granted: ["read"] })
  try {
    const escaped = await run("workspaceFixture.escape", join(folder, "link", "secret.txt"))
    assert.equal(escaped.code, "NoPermissions")
    assert.match(escaped.message, /outside the workspace folder/)
    // The fixture's first write is refused, and the reason reaches the extension.
    await assert.rejects(run("workspaceFixture.fs", folder), /filesystem:write/)
  } finally {
    host.stop()
  }
})

test("findFiles sends the pattern and revives the answer; watchers get their events", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ws-find-")))
  const { host, run, requests } = await startWorkspace({ folder })
  try {
    assert.deepEqual(await run("workspaceFixture.find"), [
      "file:///repo/src/a.ts",
      "file:///repo/src/b/c.ts",
    ])
    assert.deepEqual(requests.find((entry) => entry.method === "workspace:findFiles").params, {
      extensionId: ID,
      include: { base: "file:///repo/src", pattern: "**/*.ts" },
      exclude: null,
      maxResults: 5,
    })

    assert.deepEqual(await run("workspaceFixture.watch"), { ignoreChangeEvents: true })
    const created = requests.find((entry) => entry.method === "workspace:createFileSystemWatcher")
    assert.deepEqual(created.params.pattern, { pattern: "**/*.ts" })
    assert.equal(created.params.ignoreChangeEvents, true)
    await host.request("workspace:fileSystemEvents", {
      handle: created.params.handle,
      events: [
        { kind: "create", uri: "file:///repo/a.ts" },
        { kind: "delete", uri: "file:///repo/b.ts" },
      ],
    })
    assert.deepEqual(await run("workspaceFixture.seen"), ["create /repo/a.ts", "delete /repo/b.ts"])
    await run("workspaceFixture.unwatch")
    await host.request("workspace:fileSystemEvents", {
      handle: created.params.handle,
      events: [{ kind: "create", uri: "file:///repo/c.ts" }],
    })
    assert.equal((await run("workspaceFixture.seen")).length, 2)
  } finally {
    host.stop()
  }
})

test("settings: declared defaults, reported values, change events and updates", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ws-config-")))
  const { host, run, requests } = await startWorkspace({ folder })
  try {
    // Before any report, the extension's own package.json defaults hold.
    assert.deepEqual(await run("workspaceFixture.config"), {
      greeting: "Hello",
      server: { port: 8080 },
      port: 8080,
      missing: "fallback",
      inspect: { key: "fixture.server.port", defaultValue: 8080 },
      events: [],
    })
    await host.request("workspace:configurationChanged", {
      defaults: { "fixture.greeting": "Hello", "editor.tabSize": 4 },
      values: { "fixture.server.port": 9000 },
      changed: ["fixture.server.port"],
    })
    const after = await run("workspaceFixture.config")
    assert.equal(after.port, 9000)
    assert.equal(after.tabSize, 4)
    assert.deepEqual(after.inspect, {
      key: "fixture.server.port",
      defaultValue: 8080,
      globalValue: 9000,
    })
    assert.deepEqual(after.events, [{ fixture: true, port: true, greeting: false }])

    await run("workspaceFixture.setGreeting", "Hi")
    assert.deepEqual(
      requests.find((entry) => entry.method === "workspace:configurationUpdate").params,
      { extensionId: ID, key: "fixture.greeting", value: "Hi", target: 1 }
    )
  } finally {
    host.stop()
  }
})
