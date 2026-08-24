import {
  ADOPTION_ORIGINS,
  buildAdoptionCandidates,
  dismissAdoption,
  readDismissedAdoptions,
  type AdoptionSighting,
} from "./adopt-candidates"

const projects = [{ id: "w1", roots: [{ id: "r", path: "/src/app", isPrimary: true }] }]

function sighting(path: string, origin: AdoptionSighting["origin"]): AdoptionSighting {
  return { path, origin }
}

describe("buildAdoptionCandidates", () => {
  it("offers a directory no workspace owns", () => {
    const out = buildAdoptionCandidates([sighting("/work/site", "terminal")], projects)
    expect(out.map((c) => c.path)).toEqual(["/work/site"])
  })

  it("drops a path that is already inside a workspace", () => {
    expect(buildAdoptionCandidates([sighting("/src/app/lib", "terminal")], projects)).toEqual([])
  })

  it("drops the workspace root itself", () => {
    expect(buildAdoptionCandidates([sighting("/src/app", "worktree")], projects)).toEqual([])
  })

  it("merges the same folder seen by several surfaces", () => {
    const out = buildAdoptionCandidates(
      [
        sighting("/work/site", "terminal"),
        sighting("/work/site/", "worktree"),
        sighting("/work/site", "terminal"),
      ],
      projects
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.sightings).toBe(3)
    // Strongest origin first, and each origin listed once.
    expect(out[0]!.origins).toEqual(["worktree", "terminal"])
  })

  it("suggests the folder's own name", () => {
    const out = buildAdoptionCandidates([sighting("/work/my-site", "terminal")], projects)
    expect(out[0]!.suggestedName).toBe("my-site")
  })

  it("ranks a repository above a bare terminal cwd", () => {
    const out = buildAdoptionCandidates(
      [sighting("/work/cwd-only", "terminal"), sighting("/work/repo", "worktree")],
      projects
    )
    expect(out.map((c) => c.path)).toEqual(["/work/repo", "/work/cwd-only"])
  })

  it("breaks an origin tie by how many surfaces saw it", () => {
    const out = buildAdoptionCandidates(
      [
        sighting("/work/quiet", "terminal"),
        sighting("/work/busy", "terminal"),
        sighting("/work/busy", "terminal"),
      ],
      projects
    )
    expect(out.map((c) => c.path)).toEqual(["/work/busy", "/work/quiet"])
  })

  it("orders deterministically when origin and count agree", () => {
    // A list that reshuffles between renders is worse than an imperfect order.
    const out = buildAdoptionCandidates(
      [sighting("/b", "terminal"), sighting("/a", "terminal")],
      projects
    )
    expect(out.map((c) => c.path)).toEqual(["/a", "/b"])
  })

  it("honours a dismissal, including a differently-spelled one", () => {
    expect(
      buildAdoptionCandidates([sighting("/work/site", "terminal")], projects, ["/work/site/"])
    ).toEqual([])
  })

  it("ignores blank paths", () => {
    expect(buildAdoptionCandidates([sighting("  ", "terminal")], projects)).toEqual([])
  })

  it("offers everything when no workspace exists yet", () => {
    const out = buildAdoptionCandidates([sighting("/work/site", "terminal")], [])
    expect(out.map((c) => c.path)).toEqual(["/work/site"])
  })
})

describe("dismissal storage", () => {
  function fakeStorage(initial?: string) {
    const values = new Map<string, string>()
    if (initial !== undefined) values.set("cognia.workspace.dismissedAdoptions", initial)
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      read: (key: string) => values.get(key),
    }
  }

  it("round-trips a dismissal", () => {
    const storage = fakeStorage()
    expect(dismissAdoption("/work/site", storage)).toEqual(["/work/site"])
    expect(readDismissedAdoptions(storage)).toEqual(["/work/site"])
  })

  it("does not add the same path twice", () => {
    const storage = fakeStorage()
    dismissAdoption("/work/site", storage)
    expect(dismissAdoption("/work/site/", storage)).toEqual(["/work/site"])
  })

  it("reads an empty list when nothing is stored", () => {
    expect(readDismissedAdoptions(fakeStorage())).toEqual([])
  })

  it("survives a corrupt value rather than failing to render", () => {
    expect(readDismissedAdoptions(fakeStorage("{not json"))).toEqual([])
    expect(readDismissedAdoptions(fakeStorage('{"a":1}'))).toEqual([])
  })

  it("drops non-string entries", () => {
    expect(readDismissedAdoptions(fakeStorage('["/a", 3, null]'))).toEqual(["/a"])
  })

  it("does not throw when the quota refuses the write", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    }
    expect(() => dismissAdoption("/work/site", storage)).not.toThrow()
  })
})

describe("ADOPTION_ORIGINS", () => {
  it("is ordered strongest signal first", () => {
    // A managed worktree names a real repository; a terminal cwd might be
    // anywhere the user happened to cd. The order is what the ranking uses.
    expect(ADOPTION_ORIGINS).toEqual(["worktree", "environment", "terminal", "session"])
  })
})
