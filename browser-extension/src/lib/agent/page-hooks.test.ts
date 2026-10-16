/** @jest-environment jsdom */
import { installPageHooks } from "./page-hooks"

type HookWindow = Parameters<typeof installPageHooks>[0]

describe("installPageHooks", () => {
  it("installs once and records console lines without swallowing them", () => {
    const win = window as unknown as HookWindow
    const spy = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const hooks = installPageHooks(win, () => 5)
    expect(installPageHooks(win)).toBe(hooks)
    win.console.warn("careful", { a: 1 })
    expect(hooks.drainConsole()).toEqual([{ level: "warn", text: 'careful {"a":1}', ts: 5 }])
    expect(hooks.drainConsole()).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("never blocks on a dialog, and answers by the policy set for the next one", () => {
    const hooks = (window as unknown as { __cogniaPageHooks: ReturnType<typeof installPageHooks> })
      .__cogniaPageHooks
    expect(window.confirm("Delete?")).toBe(false)
    expect(hooks.lastDialog()).toMatchObject({
      type: "confirm",
      message: "Delete?",
      accepted: false,
    })
    hooks.setDialogPolicy({ accept: true, promptText: "Ada" })
    expect(window.prompt("Name?", "x")).toBe("Ada")
    // The policy is spent by one dialog.
    expect(window.prompt("Again?", "y")).toBeNull()
    window.alert("hi")
    expect(hooks.lastDialog()).toMatchObject({ type: "alert", accepted: true })
  })

  it("counts fetch traffic and records its outcome", async () => {
    const win = {
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      addEventListener() {},
      fetch: async () => ({ status: 201, ok: true }) as Response,
      XMLHttpRequest: undefined,
    } as unknown as HookWindow
    let clock = 0
    const hooks = installPageHooks(win, () => (clock += 10))
    await win.fetch("https://api.example/items", { method: "post" })
    expect(hooks.networkState()).toEqual({ pending: 0, completed: 1 })
    expect(hooks.drainNetwork()).toEqual([
      { url: "https://api.example/items", method: "POST", status: 201, ok: true, durationMs: 10 },
    ])
  })
})
