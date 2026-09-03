import {
  generatedFilesFrom,
  isSnapshotTextFile,
  MAX_SNAPSHOT_ENTRIES,
  MAX_TEXT_FILE_BYTES,
  SNAPSHOT_SKIP_DIRS,
} from "./source-snapshot"

describe("isSnapshotTextFile", () => {
  it.each(["plugin.json", "a/b/SKILL.md", "src/index.ts", "hooks/run.sh", "config.toml"])(
    "reads %s as text",
    (path) => expect(isSnapshotTextFile(path)).toBe(true)
  )

  it.each(["logo.png", "bin/tool", "assets/font.woff2", "archive.zip"])("placeholds %s", (path) =>
    expect(isSnapshotTextFile(path)).toBe(false)
  )
})

describe("skip list", () => {
  it("skips the directories that would blow the entry budget", () => {
    // Pointing Load unpacked at a repo checkout is a plausible mistake, and
    // node_modules alone exceeds the entry cap before the walk reaches
    // anything a converter reads.
    expect(SNAPSHOT_SKIP_DIRS.has("node_modules")).toBe(true)
    expect(SNAPSHOT_SKIP_DIRS.has(".git")).toBe(true)
  })

  it("does not skip anything a plugin bundle legitimately ships", () => {
    for (const name of ["skills", "agents", "commands", "src", "hooks", ".claude-plugin"]) {
      expect(SNAPSHOT_SKIP_DIRS.has(name)).toBe(false)
    }
  })
})

describe("limits", () => {
  it("keeps the ceilings the existing converters already enforced", () => {
    expect(MAX_SNAPSHOT_ENTRIES).toBe(2_000)
    expect(MAX_TEXT_FILE_BYTES).toBe(1_000_000)
  })
})

describe("generatedFilesFrom", () => {
  it("returns only what conversion changed", () => {
    const snapshot = new Map([
      ["README.md", "same"],
      [".claude-plugin/plugin.json", "{}"],
    ])
    const converted = new Map([
      ["README.md", "same"],
      ["plugin.json", '{"id":"x"}'],
    ])
    expect(generatedFilesFrom(snapshot, converted)).toEqual({ "plugin.json": '{"id":"x"}' })
  })

  it("counts a rewritten file as generated", () => {
    expect(
      generatedFilesFrom(new Map([["plugin.json", "old"]]), new Map([["plugin.json", "new"]]))
    ).toEqual({ "plugin.json": "new" })
  })

  it("returns nothing when conversion changed nothing", () => {
    const same = new Map([["plugin.json", "{}"]])
    expect(generatedFilesFrom(same, same)).toEqual({})
  })

  it("treats a binary placeholder as unchanged", () => {
    // Both sides carry "" for a non-text file, so it must not be overlaid.
    const snapshot = new Map([["assets/icon.png", ""]])
    expect(generatedFilesFrom(snapshot, new Map([["assets/icon.png", ""]]))).toEqual({})
  })
})
