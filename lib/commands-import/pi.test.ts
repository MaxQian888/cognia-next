import { commandsFromPiFiles } from "./pi"

const ROOT = "/home/u/.pi/agent/prompts"

describe("commandsFromPiFiles", () => {
  it("derives the command name from the path below the prompts root", () => {
    const [draft] = commandsFromPiFiles(ROOT, [
      { path: `${ROOT}/review.md`, content: "Review the diff." },
    ])
    expect(draft).toMatchObject({ id: "pi:review", name: "review", source: "pi", shared: false })
    expect(draft.body).toBe("Review the diff.")
  })

  it("keeps nested templates namespaced by their subdirectory", () => {
    const [draft] = commandsFromPiFiles(ROOT, [
      { path: `${ROOT}/git/commit.md`, content: "Commit it." },
    ])
    expect(draft.name).toBe("git/commit")
  })

  it("reads description and model out of frontmatter", () => {
    const [draft] = commandsFromPiFiles(ROOT, [
      {
        path: `${ROOT}/review.md`,
        content: "---\ndescription: Review a diff\nmodel: gpt-5.6-sol\n---\nBody here.",
      },
    ])
    expect(draft.description).toBe("Review a diff")
    expect(draft.model).toBe("gpt-5.6-sol")
    expect(draft.body).toBe("Body here.")
  })

  /**
   * Pi expands these at invocation time; Cognia's command arguments work
   * differently, so the placeholders must be flagged rather than quietly
   * carried into a template that will no longer substitute them.
   */
  it("warns when a template relies on Pi argument placeholders", () => {
    const [args] = commandsFromPiFiles(ROOT, [
      { path: `${ROOT}/a.md`, content: "Summarize $ARGUMENTS" },
    ])
    const [positional] = commandsFromPiFiles(ROOT, [
      { path: `${ROOT}/b.md`, content: "Diff $1 against $2" },
    ])
    expect(args.warnings.join(" ")).toContain("Pi argument placeholders")
    expect(positional.warnings.join(" ")).toContain("Pi argument placeholders")
  })

  it("does not warn about shell-style variables that Pi would not substitute", () => {
    const [draft] = commandsFromPiFiles(ROOT, [
      { path: `${ROOT}/c.md`, content: "Uses $HOME and $PATH." },
    ])
    expect(draft.warnings).toEqual([])
  })

  /**
   * `$5` is indistinguishable from Pi's positional placeholder — Pi really
   * would substitute it. Warning on a price is the honest failure direction;
   * staying silent would let a template change meaning after import.
   */
  it("warns on a bare $<digit> even when it was meant literally", () => {
    const [draft] = commandsFromPiFiles(ROOT, [{ path: `${ROOT}/d.md`, content: "It costs $5." }])
    expect(draft.warnings.join(" ")).toContain("Pi argument placeholders")
  })

  it("handles Windows separators in the path", () => {
    const [draft] = commandsFromPiFiles("C:\\repo\\.pi\\prompts", [
      { path: "C:\\repo\\.pi\\prompts\\review.md", content: "x" },
    ])
    expect(draft.name).toBe("review")
  })

  it("returns nothing for no files", () => {
    expect(commandsFromPiFiles(ROOT, [])).toEqual([])
  })
})
