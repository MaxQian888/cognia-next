// `vscode.env` and `window.registerUriHandler` through the real host: the
// test plays the renderer, answering the host's requests.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.env-extension"
const PATH = join(FIXTURES, "env-extension")

async function startEnv(answer = () => null) {
  const commands = new Map()
  const requests = []
  let clipboard = ""
  const host = startHost(ID, (method, params) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    if (method === "env:clipboardWriteText") {
      clipboard = params.text
      return null
    }
    if (method === "env:clipboardReadText") return clipboard
    return answer(method, params)
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
  const sent = (method) => requests.filter((entry) => entry.method === method)
  return { host, run, sent }
}

test("clipboard round-trips through the renderer as the extension's own requests", async () => {
  const { host, run, sent } = await startEnv()
  try {
    assert.equal(await run("envFixture.clipboard"), "from extension")
    assert.deepEqual(sent("env:clipboardWriteText")[0].params, {
      extensionId: ID,
      text: "from extension",
    })
  } finally {
    host.stop()
  }
})

test("openExternal sends links as written and answers with what the renderer did", async () => {
  const { host, run, sent } = await startEnv((method, params) =>
    method === "env:openExternal" ? params.target.startsWith("https:") : null
  )
  try {
    assert.equal(await run("envFixture.openWeb"), true)
    assert.equal(await run("envFixture.openString"), false)
    assert.deepEqual(
      sent("env:openExternal").map((entry) => entry.params.target),
      ["https://example.com/login?a=1&b=2", "mailto:someone@example.com"]
    )
  } finally {
    host.stop()
  }
})

test("asExternalUri hands back the renderer's deep link as a Uri", async () => {
  const { host, run, sent } = await startEnv((method, params) =>
    method === "env:asExternalUri" ? params.target.replace("cognia://", "cognia://plugin/") : null
  )
  try {
    assert.deepEqual(await run("envFixture.callbackUri"), {
      scheme: "cognia",
      authority: "plugin",
      path: `/${ID}/did-authenticate`,
    })
    assert.equal(
      sent("env:asExternalUri")[0].params.target,
      `cognia://${ID}/did-authenticate?nonce=1`
    )
  } finally {
    host.stop()
  }
})

test("a refused request rejects the extension's call with the renderer's reason", async () => {
  const { host, run } = await startEnv((method) => {
    if (method === "env:openExternal") throw new Error("requires permission shell:execute")
    return null
  })
  try {
    await assert.rejects(run("envFixture.openWeb"), /requires permission shell:execute/)
  } finally {
    host.stop()
  }
})

test("URI handler: registered once, reached through its token, replaceable after dispose", async () => {
  const { host, run, sent } = await startEnv()
  try {
    const [registration] = sent("window:registerUriHandler")
    assert.equal(registration.params.extensionId, ID)
    await host.request("extension:call", {
      extensionId: ID,
      token: registration.params.token,
      method: "handleUri",
      payload: `cognia://${ID}/did-authenticate?code=a%20b&state=2#frag`,
    })
    assert.deepEqual(await run("envFixture.handled"), [
      {
        scheme: "cognia",
        authority: ID,
        path: "/did-authenticate",
        query: "code=a b&state=2",
        fragment: "frag",
      },
    ])
    assert.match(await run("envFixture.secondHandler"), /already registered/)
    assert.equal(await run("envFixture.reregister"), "registered")
    assert.equal(
      host.notifications.filter((frame) => frame.method === "window:unregisterUriHandler").length,
      1
    )
    assert.equal(sent("window:registerUriHandler").length, 2)
  } finally {
    host.stop()
  }
})
