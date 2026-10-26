/** @jest-environment jsdom */
import { runInNewContext } from "node:vm"
import { fireEvent, screen } from "@testing-library/dom"
import en from "@/i18n/messages/en/loading.json"
import zh from "@/i18n/messages/zh-CN/loading.json"
import {
  createStartupRecoveryScript,
  markStartupReactReady,
  STARTUP_RECOVERY_STORAGE_KEY,
  STARTUP_RECOVERY_TIMEOUT_MS,
} from "./startup-recovery"

function execute(messages = en.startupRecovery) {
  runInNewContext(createStartupRecoveryScript(messages), { window, document, Date })
}

function diagnostic() {
  return JSON.parse(window.sessionStorage.getItem(STARTUP_RECOVERY_STORAGE_KEY) ?? "null")
}

beforeEach(() => {
  jest.useFakeTimers()
  window.history.replaceState(null, "", "/?secret=never-save#token")
  window.sessionStorage.clear()
  document.body.innerHTML = "<main>Preparing workspace</main>"
})

afterEach(() => {
  markStartupReactReady()
  delete window.__COGNIA_STARTUP_RECOVERY__
  jest.restoreAllMocks()
  jest.useRealTimers()
})

it("runs the emitted script without Next or React and shows recovery only after the deadline", () => {
  execute()
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS - 1)
  expect(screen.queryByRole("alert")).toBeNull()
  jest.advanceTimersByTime(1)
  expect(screen.getByRole("alert")).toHaveTextContent(en.startupRecovery.title)
  expect(screen.getByRole("button", { name: en.startupRecovery.reload })).toBeEnabled()
  expect(diagnostic()).toMatchObject({ version: 1, state: "timed-out" })
})

it("clears the watchdog on React handoff, even while the account load remains pending", () => {
  execute()
  markStartupReactReady()
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS * 2)
  expect(screen.queryByRole("alert")).toBeNull()
  expect(jest.getTimerCount()).toBe(0)
})

it("does not install a second watchdog when the inline script executes twice", () => {
  execute()
  execute()
  expect(jest.getTimerCount()).toBe(1)
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS)
  expect(screen.getAllByRole("alert")).toHaveLength(1)
})

it("removes an already visible fallback when hydration eventually reaches the initializer", () => {
  execute()
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS)
  markStartupReactReady()
  expect(screen.queryByRole("alert")).toBeNull()
  expect(diagnostic()).toMatchObject({ state: "react-ready", timedOut: true })
})

it("captures bounded content-free resource, runtime and promise failures before hydration", () => {
  execute()
  const script = document.createElement("script")
  script.src = "/_next/static/chunks/example.js?secret=hidden"
  document.head.appendChild(script)
  script.dispatchEvent(new Event("error"))
  window.dispatchEvent(
    new ErrorEvent("error", {
      message: "private prompt sk-secret",
      error: new TypeError("private prompt"),
      filename: window.location.origin + "/_next/static/chunks/runtime.js?secret=hidden#token",
      lineno: 12,
      colno: 34,
    })
  )
  const rejection = new Event("unhandledrejection")
  Object.defineProperty(rejection, "reason", { value: new Error("private token") })
  window.dispatchEvent(rejection)
  expect(diagnostic().events.map((event: { kind: string }) => event.kind)).toEqual([
    "script-resource",
    "runtime-error",
    "promise-rejection",
  ])
  expect(diagnostic().events[0].asset).toBe("/_next/static/chunks/example.js")
  expect(diagnostic().events[1]).toMatchObject({
    asset: "/_next/static/chunks/runtime.js",
    errorClass: "TypeError",
    line: 12,
    column: 34,
  })
  for (let i = 0; i < 20; i += 1) window.dispatchEvent(rejection)
  expect(diagnostic().events).toHaveLength(8)
  expect(JSON.stringify(diagnostic())).not.toMatch(/private|secret|token|\?+|#token/)
  script.remove()
})

it("ignores image errors and stops capturing after the React handoff", () => {
  execute()
  const image = document.createElement("img")
  document.body.appendChild(image)
  fireEvent.error(image)
  expect(diagnostic()).toBeNull()
  markStartupReactReady()
  window.dispatchEvent(new ErrorEvent("error", { message: "late failure" }))
  expect(diagnostic()).toBeNull()
})

it("omits arbitrary or cross-origin paths and unknown error classes from diagnostics", () => {
  execute()
  for (const filename of [
    "/private/customer-file.js?token=private",
    "https://other.example/_next/static/chunks/x.js",
  ]) {
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: { name: "private error class" },
        filename,
        lineno: Infinity,
        colno: -1,
      })
    )
  }
  expect(diagnostic().events).toEqual([
    { kind: "runtime-error", elapsedMs: 0 },
    { kind: "runtime-error", elapsedMs: 0 },
  ])
})

it("captures stylesheet failures without keeping their query strings", () => {
  execute()
  const stylesheet = document.createElement("link")
  stylesheet.rel = "stylesheet"
  stylesheet.href = "/_next/static/css/app.css?token=private"
  document.head.appendChild(stylesheet)
  fireEvent.error(stylesheet)
  expect(diagnostic().events[0]).toMatchObject({
    kind: "stylesheet-resource",
    asset: "/_next/static/css/app.css",
  })
  stylesheet.remove()
})

it("reloads only after an explicit click and never clears browser data", () => {
  const reload = jest.fn()
  const clearStorage = jest.spyOn(Storage.prototype, "clear")
  const fakeWindow = {
    location: { pathname: "/", reload },
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    __COGNIA_STARTUP_RECOVERY__: undefined as Window["__COGNIA_STARTUP_RECOVERY__"],
  }
  runInNewContext(createStartupRecoveryScript(en.startupRecovery), {
    window: fakeWindow,
    document,
    Date,
  })
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS * 3)
  expect(reload).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: en.startupRecovery.reload }))
  expect(reload).toHaveBeenCalledTimes(1)
  expect(clearStorage).not.toHaveBeenCalled()
  fakeWindow.__COGNIA_STARTUP_RECOVERY__?.complete()
})

it("includes only validated build fingerprints", () => {
  const originalCommit = process.env.NEXT_PUBLIC_GIT_COMMIT
  const originalTime = process.env.NEXT_PUBLIC_BUILD_TIME
  try {
    process.env.NEXT_PUBLIC_GIT_COMMIT = "0123456789abcdef"
    process.env.NEXT_PUBLIC_BUILD_TIME = "2026-10-19T04:05:06.000Z"
    execute()
    jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS)
    expect(diagnostic()).toMatchObject({
      buildCommit: "0123456789abcdef",
      buildTime: "2026-10-19T04:05:06.000Z",
    })
  } finally {
    if (originalCommit === undefined) delete process.env.NEXT_PUBLIC_GIT_COMMIT
    else process.env.NEXT_PUBLIC_GIT_COMMIT = originalCommit
    if (originalTime === undefined) delete process.env.NEXT_PUBLIC_BUILD_TIME
    else process.env.NEXT_PUBLIC_BUILD_TIME = originalTime
  }
})

it("still renders recovery when browser storage is unavailable", () => {
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked")
  })
  execute(zh.startupRecovery)
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS)
  expect(screen.getByRole("alert")).toHaveTextContent(zh.startupRecovery.title)
})

it("renders translations as text and escapes HTML script terminators and Unicode separators", () => {
  const title = "</script><script>bad()</script>\u2028\u2029"
  const script = createStartupRecoveryScript({ ...en.startupRecovery, title })
  expect(script).not.toContain("</script")
  expect(script).not.toMatch(/[\u2028\u2029]/)
  runInNewContext(script, { window, document, Date })
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS)
  expect(screen.getByRole("alert").textContent).toContain(title)
  expect(document.body.querySelector("script")).toBeNull()
})

it.each([
  "/status",
  "/logto/callback/",
  "/pet-overlay.html",
  "/pet-popup",
  "/island",
  "/selection-toolbar",
  "/tray-panel",
  "/recorder-controller",
  "/prototype/test",
])("does not cover the lightweight route %s with workspace recovery", (pathname) => {
  window.history.replaceState(null, "", pathname)
  execute()
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS)
  expect(screen.queryByRole("alert")).toBeNull()
  expect(window.__COGNIA_STARTUP_RECOVERY__).toBeUndefined()
})

it("does not mistake an application route with a lightweight prefix for an overlay", () => {
  window.history.replaceState(null, "", "/status-settings")
  execute()
  jest.advanceTimersByTime(STARTUP_RECOVERY_TIMEOUT_MS)
  expect(screen.getByRole("alert")).toBeInTheDocument()
})
