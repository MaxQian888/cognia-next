/** @jest-environment jsdom */

import {
  classifyOutcome,
  createExportController,
  renderExportBar,
  type ExportOutcomeLike,
} from "./export-control"

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("classifyOutcome", () => {
  it.each<[string, ExportOutcomeLike, ReturnType<typeof classifyOutcome>]>([
    [
      "a confirmation request",
      { ok: false, requiresConfirmation: true, unsupportedFeatures: ["a", "b"] },
      { phase: "confirm", count: 2 },
    ],
    [
      "a saved file",
      { ok: true, saved: true, filename: "q.xlsx" },
      { phase: "saved", filename: "q.xlsx" },
    ],
    ["a cancelled dialog", { ok: false, saved: false, cancelled: true }, { phase: "cancelled" }],
    [
      "validation errors",
      { ok: false, findings: [{ severity: "error" }], error: "fix" },
      { phase: "blocked" },
    ],
    [
      "a package that did not reopen",
      { ok: false, reason: "invalid-package", error: "English detail" },
      { phase: "invalid" },
    ],
    ["anything else", { ok: false, error: "boom" }, { phase: "failed", error: "boom" }],
  ])("maps %s", (_label, outcome, expected) => {
    expect(classifyOutcome(outcome)).toEqual(expected)
  })
})

describe("createExportController", () => {
  it("runs once at a time, asks before dropping features, and retries with consent", async () => {
    const run = jest
      .fn<Promise<ExportOutcomeLike>, [boolean]>()
      .mockResolvedValueOnce({ ok: false, requiresConfirmation: true, unsupportedFeatures: ["x"] })
      .mockResolvedValueOnce({ ok: true, saved: true, filename: "book.xlsx" })
    const onChange = jest.fn()
    const controller = createExportController({ run, onChange, isDisposed: () => false })

    controller.start(false)
    controller.start(false)
    expect(controller.state).toEqual({ phase: "working" })
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenLastCalledWith(false)
    expect(controller.state).toEqual({ phase: "confirm", count: 1 })

    controller.start(true)
    await flush()
    expect(run).toHaveBeenLastCalledWith(true)
    expect(controller.state).toEqual({ phase: "saved", filename: "book.xlsx" })
    expect(onChange).toHaveBeenCalled()
  })

  it("dismisses a confirmation, reports thrown errors, and stays quiet once disposed", async () => {
    let disposed = false
    const onChange = jest.fn()
    const run = jest
      .fn<Promise<ExportOutcomeLike>, [boolean]>()
      .mockResolvedValueOnce({ ok: false, requiresConfirmation: true })
      .mockRejectedValueOnce(new Error("disk full"))
    const controller = createExportController({ run, onChange, isDisposed: () => disposed })
    controller.start(false)
    await flush()
    controller.dismiss()
    expect(controller.state).toEqual({ phase: "idle" })
    // Dismissing outside a confirmation changes nothing.
    controller.dismiss()
    expect(controller.state).toEqual({ phase: "idle" })

    controller.start(false)
    disposed = true
    const calls = onChange.mock.calls.length
    await flush()
    expect(controller.state).toEqual({ phase: "failed", error: "disk full" })
    expect(onChange).toHaveBeenCalledTimes(calls)
  })
})

describe("renderExportBar", () => {
  it("renders the export button with a hidden empty status when idle", () => {
    const controller = createExportController({
      run: jest.fn(),
      onChange: jest.fn(),
      isDisposed: () => false,
    })
    const bar = renderExportBar(controller, t, "x")
    expect(bar.getAttribute("role")).toBe("toolbar")
    expect(bar.getAttribute("aria-label")).toBe("export.toolbar")
    const buttons = [...bar.querySelectorAll("button")]
    expect(buttons.map((button) => button.dataset.focusKey)).toEqual(["export:run"])
    expect(bar.querySelector("p")?.textContent).toBe("")
  })

  it("locks the button while working and renders confirmation choices", async () => {
    let resolve: (outcome: ExportOutcomeLike) => void = () => {}
    const run = jest.fn(
      () =>
        new Promise<ExportOutcomeLike>((done) => {
          resolve = done
        })
    )
    const controller = createExportController({ run, onChange: jest.fn(), isDisposed: () => false })
    const idle = renderExportBar(controller, t, "x")
    idle.querySelector("button")!.click()
    await flush()
    const working = renderExportBar(controller, t, "x")
    const locked = working.querySelector("button")!
    expect(locked.getAttribute("aria-disabled")).toBe("true")
    locked.click()
    expect(run).toHaveBeenCalledTimes(1)
    expect(working.querySelector("p")?.textContent).toBe("export.working")

    resolve({ ok: false, requiresConfirmation: true, unsupportedFeatures: ["a"] })
    await flush()
    const confirm = renderExportBar(controller, t, "x")
    expect([...confirm.querySelectorAll("button")].map((b) => b.dataset.focusKey)).toEqual([
      "export:confirm",
      "export:dismiss",
    ])
    expect(confirm.querySelector("p")?.textContent).toBe('export.confirm {"count":1}')
    confirm.querySelectorAll("button")[1].click()
    expect(controller.state).toEqual({ phase: "idle" })
  })

  it("announces a refused package and an unexplained failure in the UI's own words", async () => {
    const invalid = createExportController({
      run: async () => ({ ok: false, reason: "invalid-package", error: "English detail" }),
      onChange: jest.fn(),
      isDisposed: () => false,
    })
    invalid.start(false)
    await flush()
    const invalidStatus = renderExportBar(invalid, t, "x").querySelector("p")!
    expect(invalidStatus.getAttribute("role")).toBe("alert")
    expect(invalidStatus.textContent).toBe("export.invalid")

    const unexplained = createExportController({
      run: async () => ({ ok: false }),
      onChange: jest.fn(),
      isDisposed: () => false,
    })
    unexplained.start(false)
    await flush()
    expect(renderExportBar(unexplained, t, "x").querySelector("p")?.textContent).toBe(
      "export.failedUnknown"
    )
  })

  it("announces failures as alerts", async () => {
    const controller = createExportController({
      run: async () => ({ ok: false, findings: [{ severity: "error" }] }),
      onChange: jest.fn(),
      isDisposed: () => false,
    })
    controller.start(false)
    await flush()
    const status = renderExportBar(controller, t, "x").querySelector("p")!
    expect(status.getAttribute("role")).toBe("alert")
    expect(status.textContent).toBe("export.blocked")
  })
})
