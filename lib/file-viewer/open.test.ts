/** @jest-environment jsdom */
import { useProjectStore } from "@/stores/project/project-store"
import { useFileViewerStore } from "@/stores/file-viewer/file-viewer-store"
import { __resetFileViewerSequenceForTesting, openFileViewer, projectRootsOf } from "./open"

function seedProjects(
  projects: Array<{ id: string; name: string; roots: Array<{ path: string; primary?: boolean }> }>
) {
  useProjectStore.setState({
    projects: projects.map((project) => ({
      ...project,
      roots: project.roots.map((root, index) => ({
        id: `${project.id}-r${index}`,
        path: root.path,
        primary: root.primary ?? index === 0,
      })),
    })),
  } as never)
}

beforeEach(() => {
  __resetFileViewerSequenceForTesting()
  useFileViewerStore.setState({ open: false, request: null, failure: null })
  seedProjects([])
})

describe("openFileViewer", () => {
  it("resolves an absolute path into a confined request", () => {
    seedProjects([{ id: "p1", name: "app", roots: [{ path: "/work/app" }] }])

    openFileViewer("/work/app/src/index.ts", { line: 12, column: 3 })

    expect(useFileViewerStore.getState()).toMatchObject({
      open: true,
      failure: null,
      request: {
        source: "terminal",
        root: "/work/app",
        relPath: "src/index.ts",
        displayName: "src/index.ts",
        line: 12,
        column: 3,
      },
    })
  })

  it("resolves against every open project, not just one", () => {
    // The same set `allowed-roots-sync` pushes to Rust, so a stack frame
    // pointing into a sibling checkout the user also has open still resolves.
    seedProjects([
      { id: "p1", name: "app", roots: [{ path: "/work/app" }] },
      { id: "p2", name: "lib", roots: [{ path: "/work/lib" }] },
    ])

    openFileViewer("/work/lib/src/a.ts")

    expect(useFileViewerStore.getState().request).toMatchObject({
      root: "/work/lib",
      relPath: "src/a.ts",
    })
  })

  it("prefers the caller's own root when two roots are equally deep", () => {
    seedProjects([
      { id: "p1", name: "a", roots: [{ path: "/work/shared" }] },
      { id: "p2", name: "b", roots: [{ path: "/work/shared" }] },
    ])

    openFileViewer("/work/shared/a.ts", { preferredRoots: ["/work/shared"] })

    expect(useFileViewerStore.getState().request?.root).toBe("/work/shared")
  })

  it("opens on a refusal rather than doing nothing when the path is outside every root", () => {
    seedProjects([{ id: "p1", name: "app", roots: [{ path: "/work/app" }] }])

    openFileViewer("/usr/lib/node_modules/x/index.js")

    // This is the behaviour change users will notice, and it is the point: a
    // path outside the workspaces is refused out loud rather than read.
    expect(useFileViewerStore.getState()).toMatchObject({
      open: true,
      request: null,
      failure: { code: "outside-workspace", displayName: "index.js" },
    })
  })

  it("distinguishes having no workspaces at all from being outside the ones we have", () => {
    openFileViewer("/anywhere/a.ts")

    expect(useFileViewerStore.getState().failure).toMatchObject({ code: "no-root" })
  })

  it("gives every open a distinct id so a stale read can be discarded", () => {
    seedProjects([{ id: "p1", name: "app", roots: [{ path: "/work/app" }] }])

    openFileViewer("/work/app/a.ts")
    const first = useFileViewerStore.getState().request?.requestId
    openFileViewer("/work/app/b.ts")
    const second = useFileViewerStore.getState().request?.requestId

    expect(first).not.toBe(second)
  })

  it("refuses a directory and a traversal", () => {
    seedProjects([{ id: "p1", name: "app", roots: [{ path: "/work/app" }] }])

    openFileViewer("/work/app")
    expect(useFileViewerStore.getState().failure?.code).toBe("outside-workspace")

    openFileViewer("/work/app/../secrets.txt")
    expect(useFileViewerStore.getState().failure?.code).toBe("outside-workspace")
  })
})

describe("projectRootsOf", () => {
  it("returns every root of the named project", () => {
    seedProjects([
      { id: "p1", name: "app", roots: [{ path: "/work/app" }, { path: "/work/extra" }] },
    ])
    expect(projectRootsOf("p1")).toEqual(["/work/app", "/work/extra"])
  })

  it("returns nothing for an unknown or absent project", () => {
    expect(projectRootsOf(null)).toEqual([])
    expect(projectRootsOf("missing")).toEqual([])
  })
})
