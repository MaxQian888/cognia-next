// `WindowEnvironment`: the app window's focus and theme as the renderer
// reports them, behind `window.state` and `window.activeColorTheme`.
import assert from "node:assert/strict"
import { test } from "node:test"

import { WindowEnvironment } from "../dist/vscode-shim/window-state.js"

function connection(answer) {
  const handlers = new Map()
  const sent = []
  return {
    handlers,
    sent,
    onRequest: (method, handler) => handlers.set(method, handler),
    sendRequest: async (method, params) => {
      sent.push(method)
      return answer(params)
    },
  }
}

test("before any report the window is focused, active and dark", () => {
  const environment = new WindowEnvironment()
  assert.deepEqual(environment.state, { focused: true, active: true })
  assert.deepEqual(environment.colorTheme, { kind: 2 })
})

test("load asks the renderer once and takes its answer", async () => {
  const environment = new WindowEnvironment()
  const fake = connection(() => ({ focused: false, active: false, colorThemeKind: 1 }))
  await Promise.all([environment.load(fake, () => {}), environment.load(fake, () => {})])
  assert.deepEqual(fake.sent, ["window:describeEnvironment"])
  assert.deepEqual(environment.state, { focused: false, active: false })
  assert.deepEqual(environment.colorTheme, { kind: 1 })
})

test("a renderer that cannot answer leaves the defaults and is logged", async () => {
  const environment = new WindowEnvironment()
  const warnings = []
  const fake = connection(() => {
    throw new Error("no handler")
  })
  await environment.load(fake, (message) => warnings.push(message))
  assert.deepEqual(environment.state, { focused: true, active: true })
  assert.match(warnings[0], /could not read the window's focus and theme \(no handler\)/)
})

test("changes fire their own event, once, and malformed fields are ignored", () => {
  const environment = new WindowEnvironment()
  const fake = connection(() => null)
  environment.attach(fake)
  const states = []
  const themes = []
  environment.onDidChangeState.event((state) => states.push(state))
  environment.onDidChangeColorTheme.event((theme) => themes.push(theme))
  const report = fake.handlers.get("window:environmentChanged")

  report({ focused: false, active: true, colorThemeKind: 2 })
  report({ focused: false, active: true, colorThemeKind: 2 })
  report({ focused: "yes", active: false, colorThemeKind: 9 })
  report({ colorThemeKind: 1 })
  report(null)

  assert.deepEqual(states, [
    { focused: false, active: true },
    { focused: false, active: false },
  ])
  assert.deepEqual(themes, [{ kind: 1 }])
})
