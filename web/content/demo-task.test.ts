import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEMO_TASK } from "./demo-task"
import { en } from "./en"
import { zh } from "./zh"

describe("DEMO_TASK", () => {
  it("stays the same project the capture script seeds", () => {
    // Read as text rather than imported: the capture script is an `.mjs` node
    // script outside the Jest module graph. What matters is that a reconstruction
    // and a future screenshot of the same section describe one task, so the two
    // identities must not drift apart silently.
    const script = readFileSync(join(__dirname, "..", "scripts", "capture-product.mjs"), "utf8")
    expect(script).toContain(`repository: "${DEMO_TASK.repository}"`)
    expect(script).toContain(`branch: "${DEMO_TASK.branch}"`)
    expect(script).toContain(`failingCheck: "${DEMO_TASK.check}"`)
    expect(script).toContain(`artifact: "${DEMO_TASK.artifact.file}"`)
  })

  it("names the project as a demonstration, not as a real customer", () => {
    expect(DEMO_TASK.repository.startsWith("acme/")).toBe(true)
  })

  it("carries a diff with something added and something removed", () => {
    const kinds = DEMO_TASK.diff.lines.map((line) => line.kind)
    expect(kinds).toContain("add")
    expect(kinds).toContain("remove")
    expect(kinds).toContain("context")
  })

  it("counts the diff the way the diff reads", () => {
    expect(DEMO_TASK.diff.added).toBeGreaterThan(0)
    expect(DEMO_TASK.diff.removed).toBeGreaterThan(0)
    expect(DEMO_TASK.diff.filesChanged).toBeGreaterThan(0)
  })

  it("has exactly one failing check, which is the one the task is about", () => {
    const failing = DEMO_TASK.test.lines.filter((line) => line.state === "fail")
    expect(failing).toHaveLength(1)
  })

  it("leaves the re-run queued, matching the pending state the copy claims", () => {
    expect(DEMO_TASK.test.lines.some((line) => line.state === "queued")).toBe(true)
  })

  it("keeps the diff path among the files it says it read", () => {
    expect(DEMO_TASK.files.map((file) => file.path)).toContain(DEMO_TASK.diff.path)
  })

  it("puts chat first on the rail, which is the region the thread lives in", () => {
    expect(DEMO_TASK.rail[0]).toBe("chat")
  })
})

describe("DEMO_TASK against the copy bundles", () => {
  for (const [name, copy] of [
    ["en", en],
    ["zh", zh],
  ] as const) {
    it(`has ${name} prose for every file, plan step and output line`, () => {
      const { artifacts } = copy.reconstruction
      for (const file of DEMO_TASK.files) {
        expect(artifacts.context.fileNotes[file.key]).toBeTruthy()
      }
      for (const step of DEMO_TASK.plan) {
        expect(artifacts.plan.items[step.key].text).toBeTruthy()
      }
      for (const line of DEMO_TASK.test.lines) {
        expect(artifacts.test.lineNotes[line.key]).toBeTruthy()
      }
    })

    it(`has ${name} rail labels for every region`, () => {
      for (const key of DEMO_TASK.rail) {
        expect(copy.reconstruction.workbench.rail[key]).toBeTruthy()
      }
    })
  }

  it("does not repeat the signature task verbatim in the thread", () => {
    // The page follows one task (spec §4.9), but the hero thread and the
    // signature section stating the identical sentence reads as a copy-paste and
    // makes `getByText` ambiguous for anyone testing the page.
    for (const copy of [en, zh]) {
      expect(copy.reconstruction.workbench.userTurn).not.toBe(copy.home.signature.task)
    }
  })

  it("keeps every signature step pointed at an artifact that exists", () => {
    for (const copy of [en, zh]) {
      for (const step of copy.home.signature.steps) {
        expect(copy.reconstruction.artifacts[step.artifact]).toBeDefined()
      }
    }
  })

  it("shows all six artifacts across the six steps, with none duplicated", () => {
    const used = en.home.signature.steps.map((step) => step.artifact)
    expect(new Set(used).size).toBe(used.length)
    expect(used).toHaveLength(Object.keys(en.reconstruction.artifacts).length)
  })

  it("keeps the step status distinct from its artifact heading", () => {
    for (const copy of [en, zh]) {
      for (const step of copy.home.signature.steps) {
        const artifact = copy.reconstruction.artifacts[step.artifact]
        if ("heading" in artifact) {
          expect(artifact.heading).not.toBe(step.status)
        }
      }
    }
  })
})
