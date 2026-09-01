/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

let definitions: Array<Record<string, unknown>> = []
let owners: Record<string, string> = {}
let activeProjectId: string | null = "ws_1"
let overlay: Record<string, Record<string, boolean>> | undefined

jest.mock("@/hooks/use-template-catalog", () => ({
  useTemplateCatalog: () => ({ definitions, revision: 0 }),
}))
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => owners }))
jest.mock("@/lib/db/template-platform", () => ({ listTemplateOwners: async () => owners }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeProjectId,
      projects: [{ id: "ws_1", capabilityOverlay: overlay }],
    }),
}))

import { useScopedTemplateCatalog } from "./use-scoped-template-catalog"

function definition(id: string, source = "built-in") {
  return { id, provenance: { source } }
}

function run(options?: Parameters<typeof useScopedTemplateCatalog>[1]) {
  return renderHook(() => useScopedTemplateCatalog({}, options)).result.current
}

describe("useScopedTemplateCatalog", () => {
  beforeEach(() => {
    definitions = []
    owners = {}
    activeProjectId = "ws_1"
    overlay = undefined
  })

  it("keeps a shared definition nobody has an opinion about", () => {
    definitions = [definition("a")]
    expect(run().definitions.map((d) => d.id)).toEqual(["a"])
  })

  /** An owned definition does not exist outside its workspace. */
  it("drops a definition another workspace owns", () => {
    definitions = [definition("a")]
    owners = { a: "ws_2" }
    const result = run()
    expect(result.definitions).toEqual([])
    expect(result.hiddenCount).toBe(1)
  })

  /** The overlay is a display preference, and it only applies to shared rows. */
  it("drops a shared definition this workspace switched off", () => {
    definitions = [definition("a")]
    overlay = { template: { a: false } }
    expect(run().definitions).toEqual([])
  })

  it("counts what it is holding back, so the UI can say so", () => {
    definitions = [definition("a"), definition("b")]
    owners = { a: "ws_2" }
    expect(run().hiddenCount).toBe(1)
  })

  /**
   * While the store is still hydrating there is no workspace to filter by, and
   * silently dropping rows would look like an empty library rather than a
   * pending one.
   */
  it("filters nothing until a workspace is known", () => {
    definitions = [definition("a")]
    owners = { a: "ws_2" }
    activeProjectId = null
    expect(run().definitions.map((d) => d.id)).toEqual(["a"])
  })

  it("narrows to one shelf when asked", () => {
    definitions = [definition("a", "built-in"), definition("b", "user")]
    expect(run({ tier: "mine" }).definitions.map((d) => d.id)).toEqual(["b"])
  })

  /** Ownership beats provenance: a forked built-in is the workspace's. */
  it("reports the tier ownership implies", () => {
    definitions = [definition("a", "built-in")]
    owners = { a: "ws_1" }
    expect(run().tierOf(definition("a", "built-in") as never)).toBe("workspace")
  })
})
