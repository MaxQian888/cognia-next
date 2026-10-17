/** @jest-environment jsdom */

jest.mock("@/stores/chat", () => ({ useChatStore: { getState: jest.fn() } }))
jest.mock("./smart-snapshot", () => ({ SMART_SNAPSHOT_COMMAND_ID: "chat.captureSmartSnapshot" }))

import { useChatStore } from "@/stores/chat"
import { registerSmartSnapshotComposer } from "./smart-snapshot-command"
import { SMART_SNAPSHOT_COMMAND_ID } from "./smart-snapshot"
import {
  __resetCommandRegistryForTesting,
  executeCommand,
  getCommand,
  registerCommand,
} from "@/lib/plugin/commands/registry"

let activeSessionId: string | null
let disposers: Array<() => void>

beforeEach(() => {
  activeSessionId = "main"
  disposers = []
  __resetCommandRegistryForTesting()
  jest
    .mocked(useChatStore.getState)
    .mockImplementation(() => ({ activeSessionId }) as ReturnType<typeof useChatStore.getState>)
})

afterEach(() => {
  for (const dispose of disposers.reverse()) dispose()
  document.body.replaceChildren()
})

function mount(sessionId: string | null = "main") {
  const root = document.createElement("div")
  root.dataset.composerRoot = ""
  if (sessionId) root.dataset.composerSession = sessionId
  const textarea = document.createElement("textarea")
  root.append(textarea)
  document.body.append(root)
  const capture = jest.fn(async () => {})
  const dispose = registerSmartSnapshotComposer({
    textarea: () => textarea,
    capture,
    title: "Capture",
  })
  disposers.push(dispose)
  return { root, textarea, capture, dispose }
}

it("shares one command across composers without warning and prefers focus over mount order", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const first = mount("main")
    const second = mount("split")
    first.textarea.focus()
    await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
    expect(first.capture).toHaveBeenCalledTimes(1)
    expect(second.capture).not.toHaveBeenCalled()
    second.textarea.focus()
    await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
    expect(second.capture).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

it("keeps a sidechat destination after focus leaves Cognia", async () => {
  const main = mount("main")
  const aside = mount("aside")
  aside.textarea.focus()
  aside.textarea.blur()
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(aside.capture).toHaveBeenCalledTimes(1)
  expect(main.capture).not.toHaveBeenCalled()
})

it("falls back to the current session rather than the last mounted composer", async () => {
  const main = mount("main")
  const split = mount("split")
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(main.capture).toHaveBeenCalledTimes(1)
  expect(split.capture).not.toHaveBeenCalled()
  activeSessionId = "split"
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(split.capture).toHaveBeenCalledTimes(1)
})

it("drops remembered focus when the active conversation changes", async () => {
  const main = mount("main")
  const split = mount("split")
  main.textarea.focus()
  main.textarea.blur()
  activeSessionId = "split"
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(main.capture).not.toHaveBeenCalled()
  expect(split.capture).toHaveBeenCalledTimes(1)
})

it("uses the home composer when there is no active session", async () => {
  activeSessionId = null
  const home = mount(null)
  const exiting = mount("main")
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(home.capture).toHaveBeenCalledTimes(1)
  expect(exiting.capture).not.toHaveBeenCalled()
})

it.each(["hidden", "inert", "aria-hidden"])(
  "does not route to a remembered composer inside %s",
  async (attribute) => {
    const main = mount("main")
    const aside = mount("aside")
    aside.textarea.focus()
    aside.textarea.blur()
    aside.root.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "")
    await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
    expect(main.capture).toHaveBeenCalledTimes(1)
    expect(aside.capture).not.toHaveBeenCalled()
  }
)

it("ignores a detached composer and does not choose an unrelated session", async () => {
  const main = mount("main")
  const aside = mount("aside")
  main.root.remove()
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(main.capture).not.toHaveBeenCalled()
  expect(aside.capture).not.toHaveBeenCalled()
})

it("does not route to a remembered composer in a CSS-hidden panel", async () => {
  const main = mount("main")
  const aside = mount("aside")
  aside.textarea.focus()
  aside.textarea.blur()
  const panel = document.createElement("div")
  panel.style.display = "none"
  document.body.append(panel)
  panel.append(aside.root)
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(main.capture).toHaveBeenCalledTimes(1)
  expect(aside.capture).not.toHaveBeenCalled()
})

it("remembers pointer interaction in a composer toolbar", async () => {
  const main = mount("main")
  const aside = mount("aside")
  aside.root.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(aside.capture).toHaveBeenCalledTimes(1)
  expect(main.capture).not.toHaveBeenCalled()
})

it("does not route to a disabled composer", async () => {
  const main = mount("main")
  main.textarea.disabled = true
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(main.capture).not.toHaveBeenCalled()
})

it("keeps the command until the final composer leaves and tolerates repeated old cleanup", async () => {
  const main = mount("main")
  const aside = mount("aside")
  main.dispose()
  main.dispose()
  expect(getCommand(SMART_SNAPSHOT_COMMAND_ID)).toBeDefined()
  aside.textarea.focus()
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(aside.capture).toHaveBeenCalledTimes(1)
  aside.dispose()
  expect(getCommand(SMART_SNAPSHOT_COMMAND_ID)).toBeUndefined()
  const remounted = mount("main")
  main.dispose()
  await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
  expect(remounted.capture).toHaveBeenCalledTimes(1)
})

it("does not remove a plugin override when the last composer unmounts", async () => {
  const composer = mount()
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const handler = jest.fn()
    disposers.push(
      registerCommand({ id: SMART_SNAPSHOT_COMMAND_ID, pluginId: "override", handler })
    )
    composer.dispose()
    await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
    expect(handler).toHaveBeenCalledTimes(1)
  } finally {
    warn.mockRestore()
  }
})
