import { CreatorPreviewSession, assertPreviewClean } from "./preview"
import type { PluginDisposableScope } from "@/lib/plugin/core/disposable-scope"

function session(
  mount: (scope: PluginDisposableScope) => void | Promise<void>
): CreatorPreviewSession {
  return new CreatorPreviewSession({
    artifactKind: "plugin",
    artifactId: "creator-preview-test",
    mount,
  })
}

describe("CreatorPreviewSession", () => {
  it("mounts a generation and exposes an abort signal", async () => {
    const preview = session(() => undefined)
    await preview.start()
    expect(preview.active).toBe(true)
    expect(preview.currentGeneration).toBe(1)
    expect(preview.signal?.aborted).toBe(false)
    await preview.dispose()
  })

  it("disposes every tracked resource and reports it clean", async () => {
    const disposed: string[] = []
    const preview = session((scope) => {
      scope.track(() => void disposed.push("timer"), "timer")
      scope.track(() => void disposed.push("watcher"), "watcher")
    })
    await preview.start()

    const report = await preview.dispose()
    expect(disposed.sort()).toEqual(["timer", "watcher"])
    expect(report.disposed).toBe(2)
    expect(report.clean).toBe(true)
    expect(report.leaked).toEqual([])
  })

  // "Preview destroyed but resources leaked" is a named release blocker, so a
  // disposer that throws must surface as a leak rather than be swallowed.
  it("reports a disposer that throws as a leak", async () => {
    const preview = session((scope) => {
      scope.track(() => {
        throw new Error("stuck")
      }, "stuck-window")
    })
    await preview.start()

    const report = await preview.dispose()
    expect(report.clean).toBe(false)
    expect(report.leaked).toContain("stuck-window")
  })

  it("aborts the generation's signal on teardown", async () => {
    const preview = session(() => undefined)
    await preview.start()
    const signal = preview.signal
    await preview.dispose()
    expect(signal?.aborted).toBe(true)
  })

  it("reloads by disposing the old generation before mounting a new one", async () => {
    const order: string[] = []
    let generation = 0
    const preview = session((scope) => {
      const id = ++generation
      order.push(`mount:${id}`)
      scope.track(() => void order.push(`dispose:${id}`), `res-${id}`)
    })
    await preview.start()

    const report = await preview.reload()
    expect(order).toEqual(["mount:1", "dispose:1", "mount:2"])
    expect(report.clean).toBe(true)
    expect(preview.currentGeneration).toBe(2)
    await preview.dispose()
  })

  it("rejects a second start instead of orphaning the first scope", async () => {
    const preview = session(() => undefined)
    await preview.start()
    await expect(preview.start()).rejects.toThrow(/already started/)
    await preview.dispose()
  })

  // A mount that throws halfway may already have registered resources; leaving
  // them tracked on an abandoned scope is a silent leak.
  it("disposes resources registered by a mount that then threw", async () => {
    const disposed: string[] = []
    const preview = session((scope) => {
      scope.track(() => void disposed.push("half-built"), "half-built")
      throw new Error("mount failed")
    })

    await expect(preview.start()).rejects.toThrow("mount failed")
    expect(disposed).toEqual(["half-built"])
    expect(preview.active).toBe(false)
  })

  it("is idempotent on dispose and refuses to restart afterwards", async () => {
    const preview = session(() => undefined)
    await preview.start()
    await preview.dispose()

    const second = await preview.dispose()
    expect(second).toEqual({ disposed: 0, leaked: [], clean: true })
    await expect(preview.start()).rejects.toThrow(/already disposed/)
    await expect(preview.reload()).rejects.toThrow(/already disposed/)
  })

  it("reports a clean teardown for a reload that was never started", async () => {
    const preview = session(() => undefined)
    const report = await preview.reload()
    expect(report).toEqual({ disposed: 0, leaked: [], clean: true })
    await preview.dispose()
  })

  it("exposes the artifact kind it was created for", () => {
    expect(session(() => undefined).artifactKind).toBe("plugin")
  })
})

describe("assertPreviewClean", () => {
  it("passes a clean report", () => {
    expect(() => assertPreviewClean({ disposed: 2, leaked: [], clean: true })).not.toThrow()
  })

  it("throws with the leaked labels named", () => {
    expect(() =>
      assertPreviewClean({ disposed: 1, leaked: ["timer", "window"], clean: false })
    ).toThrow(/leaked 2 resource\(s\): timer, window/)
  })
})
