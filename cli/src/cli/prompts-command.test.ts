/** @jest-environment jsdom */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { DIFFICULTY_JUDGE_PROMPT } from "@/lib/ai/routing/difficulty-judge"
import { resolvePrompt } from "@/lib/prompts/resolve"
import { readPromptSlot } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"

import { parseArgv } from "./args"
import { promptsCommand, type PromptsCommandDeps } from "./prompts-command"
import type { OutputSink } from "./output"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const json: unknown[] = []
  const out: OutputSink = {
    write: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    json: (obj) => json.push(obj),
  }
  return { out, stdout: () => stdout.join(""), stderr: () => stderr.join("\n"), json }
}

function harness(overrides: Partial<PromptsCommandDeps> = {}) {
  const io = sink()
  const db = {
    mode: "writer" as "writer" | "read-only",
    flush: jest.fn(async () => {}),
    dispose: jest.fn(async () => {}),
  }
  const files: Record<string, string> = {}
  const deps: PromptsCommandDeps = {
    out: io.out,
    cwd: "/repo",
    openDb: async () => db,
    findWorkspaceId: async (dir) => (dir === "/repo" ? "ws-repo" : null),
    readStdin: async () => "",
    readFile: (file) => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`)
      return files[file]
    },
    writeFile: (file, text) => {
      files[file] = text
    },
    ...overrides,
  }
  const run = (argv: string) =>
    promptsCommand(parseArgv(["prompts", ...argv.split(" ").filter(Boolean)]), deps)
  return { run, io, db, files, deps }
}

it("rejects a missing or unknown subcommand", async () => {
  const { run, io } = harness()
  expect(await run("")).toBe(2)
  expect(await run("frobnicate")).toBe(2)
  expect(io.stderr()).toContain("expected a subcommand")
})

it("publishes from stdin, shows it, lists it as modified and resets it", async () => {
  const { run, io, db } = harness({ readStdin: async () => "Answer in one line.\n" })
  expect(await run(`set ${BRIEF_MODE_PROMPT.id}`)).toBe(0)
  expect(db.flush).toHaveBeenCalled()
  expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe("Answer in one line.")
  const slot = await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "account", targetId: "" })
  expect(slot.active?.origin).toBe("cli")

  expect(await run(`show ${BRIEF_MODE_PROMPT.id}`)).toBe(0)
  expect(io.stdout()).toContain("--- shipped ---")
  expect(io.stdout()).toContain("Answer in one line.")

  expect(await run("list --modified --json")).toBe(0)
  expect(io.json.at(-1)).toEqual([
    expect.objectContaining({
      id: BRIEF_MODE_PROMPT.id,
      overrides: [{ scope: "account", targetId: "" }],
    }),
  ])

  expect(await run(`reset ${BRIEF_MODE_PROMPT.id}`)).toBe(0)
  expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe(BRIEF_MODE_PROMPT.defaultBody)
  expect(db.dispose).toHaveBeenCalled()
})

it("targets the workspace mounting the cwd for --scope workspace", async () => {
  const { run, files } = harness()
  files["/repo/brief.md"] = "Workspace brevity."
  expect(await run(`set ${BRIEF_MODE_PROMPT.id} --scope workspace --file /repo/brief.md`)).toBe(0)
  const slot = await readPromptSlot(BRIEF_MODE_PROMPT.id, {
    scope: "workspace",
    targetId: "ws-repo",
  })
  expect(slot.active?.body).toBe("Workspace brevity.")
})

it("refuses an invalid body, an ineligible scope and an unknown id without writing", async () => {
  const { run, io } = harness({ readStdin: async () => "no tier contract" })
  expect(await run(`set ${DIFFICULTY_JUDGE_PROMPT.id}`)).toBe(1)
  expect(io.stderr()).toContain('must keep "\\"tier\\""')
  expect(await run(`set ${BRIEF_MODE_PROMPT.id} --scope session --target s1`)).toBe(2)
  expect(await run("set nope.missing")).toBe(2)
  expect(
    (await readPromptSlot(DIFFICULTY_JUDGE_PROMPT.id, { scope: "account", targetId: "" })).binding
  ).toBeUndefined()
})

it("refuses an empty body", async () => {
  const { run, io } = harness({ readStdin: async () => "\n" })
  expect(await run(`set ${BRIEF_MODE_PROMPT.id}`)).toBe(1)
  expect(io.stderr()).toContain("empty")
})

it("refuses writes while another process owns the store", async () => {
  const { run, db, io } = harness({ readStdin: async () => "x" })
  db.mode = "read-only"
  expect(await run(`set ${BRIEF_MODE_PROMPT.id}`)).toBe(1)
  expect(io.stderr()).toContain("read-only")
  expect(db.flush).not.toHaveBeenCalled()
  // Reads still work.
  expect(await run("list")).toBe(0)
})

it("exports a profile and imports it with a preview, a target map and --yes", async () => {
  const source = harness({ readStdin: async () => "Exported brevity." })
  await source.run(`set ${BRIEF_MODE_PROMPT.id}`)
  source.files["/repo/ws.md"] = "Per workspace."
  await source.run(`set ${BRIEF_MODE_PROMPT.id} --scope workspace --file /repo/ws.md`)
  expect(await source.run("export --output /tmp/profile.json")).toBe(0)
  const profile = source.files["/tmp/profile.json"]
  expect(JSON.parse(profile).entries).toHaveLength(2)

  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  const target = harness()
  target.files["/tmp/profile.json"] = profile
  expect(await target.run("import /tmp/profile.json")).toBe(0)
  expect(target.io.stdout()).toContain("needs-target")
  expect(target.io.stdout()).toContain("Run again with --yes")
  expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe(BRIEF_MODE_PROMPT.defaultBody)

  expect(await target.run("import /tmp/profile.json --map workspace:ws-repo=ws-new --yes")).toBe(0)
  expect(target.io.stdout()).toContain("Published 2 override(s).")
  expect(resolvePrompt(BRIEF_MODE_PROMPT).text).toBe("Exported brevity.")
  const mapped = await readPromptSlot(BRIEF_MODE_PROMPT.id, {
    scope: "workspace",
    targetId: "ws-new",
  })
  expect(mapped.active?.body).toBe("Per workspace.")
})

it("reports a malformed profile file", async () => {
  const { run, files, io } = harness()
  files["/tmp/bad.json"] = "{"
  expect(await run("import /tmp/bad.json")).toBe(1)
  expect(io.stderr()).toContain("not JSON")
})
