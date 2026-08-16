import {
  CreatorPortUnavailableError,
  createCreatorHandlers,
  createPreviewHandler,
  createStaticRequirementsHandler,
} from "./handlers"
import type { CreatorRunContext } from "./executor"
import type { AuthoringRoot } from "@/types/creator"

const root: AuthoringRoot = {
  path: "/work/authoring",
  label: "authoring",
  origin: "selected",
  grantedAt: 0,
}

const ctx: CreatorRunContext = {
  runId: "creator_1",
  root,
  artifactKind: "plugin",
  requirements: "r",
  currentCapabilities: [],
  approvedAdditions: [],
}

describe("createCreatorHandlers", () => {
  // The property this module exists for: an unconnected port must be
  // impossible to mistake for a working no-op.
  it.each([
    "collectRequirements",
    "surveyExisting",
    "planScaffold",
    "verify",
    "preview",
    "review",
    "deliver",
  ] as const)("fails loudly for the unimplemented %s port", async (port) => {
    const handlers = createCreatorHandlers()
    await expect((handlers[port] as (c: unknown) => Promise<unknown>)(ctx)).rejects.toThrow(
      CreatorPortUnavailableError
    )
  })

  it("names the port and the reason in the error", async () => {
    const handlers = createCreatorHandlers()
    await expect(handlers.planScaffold(ctx)).rejects.toThrow(/planScaffold.*agent session/)
  })

  it("uses an override in place of the failing default", async () => {
    const handlers = createCreatorHandlers({
      planScaffold: async () => ({ files: [], capabilities: ["fs.read"] }),
    })
    await expect(handlers.planScaffold(ctx)).resolves.toEqual({
      files: [],
      capabilities: ["fs.read"],
    })
  })

  it("leaves the other ports failing when one is overridden", async () => {
    const handlers = createCreatorHandlers({
      planScaffold: async () => ({ files: [], capabilities: [] }),
    })
    await expect(handlers.verify(ctx)).rejects.toThrow(CreatorPortUnavailableError)
  })
})

describe("createStaticRequirementsHandler", () => {
  it("returns the trimmed requirements", async () => {
    await expect(createStaticRequirementsHandler("  build a thing  ")(ctx)).resolves.toEqual({
      requirements: "build a thing",
    })
  })

  it("refuses an empty field rather than proceeding with nothing", async () => {
    await expect(createStaticRequirementsHandler("   ")(ctx)).rejects.toThrow(
      CreatorPortUnavailableError
    )
  })
})

describe("createPreviewHandler", () => {
  it("mounts, tears down, and reports a clean release", async () => {
    const disposed: string[] = []
    const handler = createPreviewHandler((scope) => {
      scope.track(() => void disposed.push("timer"), "timer")
    })

    await expect(handler(ctx)).resolves.toEqual({ clean: true, leaked: [] })
    expect(disposed).toEqual(["timer"])
  })

  // A leak has to reach the executor, which fails the step on it.
  it("reports a disposer that threw as a leak", async () => {
    const handler = createPreviewHandler((scope) => {
      scope.track(() => {
        throw new Error("stuck")
      }, "stuck-window")
    })

    const report = await handler(ctx)
    expect(report.clean).toBe(false)
    expect(report.leaked).toContain("stuck-window")
  })

  it("propagates a mount failure rather than reporting a clean preview", async () => {
    const handler = createPreviewHandler(() => {
      throw new Error("mount failed")
    })
    await expect(handler(ctx)).rejects.toThrow("mount failed")
  })
})
