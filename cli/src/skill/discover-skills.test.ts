/**
 * @jest-environment node
 */
import {
  discoverDiskSkills,
  findDiskSkillByCanonicalId,
  listSkillBundledFiles,
  seedDiskSkills,
  skillScanDirs,
  skillOriginLabel,
  type SkillFs,
  type SkillScanDir,
} from "./discover-skills"

/** In-memory fs. `dirs` maps a directory → its entries; `files` maps a path →
 * its text. A path is a directory iff it's a key in `dirs`. */
function memFs(dirs: Record<string, string[]>, files: Record<string, string>): SkillFs {
  const norm = (p: string) => p.replace(/\\/g, "/")
  return {
    async exists(p) {
      const n = norm(p)
      return n in dirs || n in files
    },
    async readDir(p) {
      return dirs[norm(p)] ?? []
    },
    async readText(p) {
      const n = norm(p)
      if (!(n in files)) throw new Error(`ENOENT ${n}`)
      return files[n]
    },
    async isDirectory(p) {
      return norm(p) in dirs
    },
  }
}

const SKILL = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${name} desc\n---\n\n${body}`

describe("discoverDiskSkills", () => {
  it("discovers folder (SKILL.md) and flat (*.md) skills", async () => {
    const fs = memFs(
      {
        "/proj/.cognia/skills": ["folder-skill", "flat-skill.md", "README.txt"],
        "/proj/.cognia/skills/folder-skill": ["SKILL.md", "helper.py"],
      },
      {
        "/proj/.cognia/skills/folder-skill/SKILL.md": SKILL("Folder Skill"),
        "/proj/.cognia/skills/flat-skill.md": SKILL("Flat Skill"),
      }
    )
    const dirs: SkillScanDir[] = [{ dir: "/proj/.cognia/skills", source: "project" }]
    const found = await discoverDiskSkills(dirs, fs)
    const ids = found.map((s) => s.id).sort()
    expect(ids).toEqual(["flat-skill", "folder-skill"])
    const folder = found.find((s) => s.id === "folder-skill")!
    expect(folder.draft.name).toBe("Folder Skill")
    expect(folder.canonicalId).toBe("cli-disk:project:folder-skill")
    expect(folder.draft.source).toBe("imported")
  })

  it("lets a project skill win over a global one with the same id", async () => {
    const fs = memFs(
      {
        "/proj/.cognia/skills": ["dup.md"],
        "/home/skills": ["dup.md"],
      },
      {
        "/proj/.cognia/skills/dup.md": SKILL("Project Dup", "project body"),
        "/home/skills/dup.md": SKILL("Global Dup", "global body"),
      }
    )
    const found = await discoverDiskSkills(
      [
        { dir: "/proj/.cognia/skills", source: "project" },
        { dir: "/home/skills", source: "global" },
      ],
      fs
    )
    expect(found).toHaveLength(1)
    expect(found[0].draft.name).toBe("Project Dup")
    expect(found[0].source).toBe("project")
  })

  it("skips unparseable skills but keeps the rest", async () => {
    const fs = memFs(
      { "/proj/.cognia/skills": ["good.md", "empty.md"] },
      {
        "/proj/.cognia/skills/good.md": SKILL("Good"),
        "/proj/.cognia/skills/empty.md": "---\nname: Empty\n---\n", // no body → throws
      }
    )
    const found = await discoverDiskSkills([{ dir: "/proj/.cognia/skills", source: "project" }], fs)
    expect(found.map((s) => s.id)).toEqual(["good"])
  })

  it("returns nothing when the directory is absent", async () => {
    const fs = memFs({}, {})
    expect(
      await discoverDiskSkills([{ dir: "/nope/.cognia/skills", source: "project" }], fs)
    ).toEqual([])
  })
})

describe("discovered file paths", () => {
  it("records the SKILL.md path + dir for folder skills and only the path for flat skills", async () => {
    const fs = memFs(
      {
        "/proj/.cognia/skills": ["folder-skill", "flat-skill.md"],
        "/proj/.cognia/skills/folder-skill": ["SKILL.md", "helper.py"],
      },
      {
        "/proj/.cognia/skills/folder-skill/SKILL.md": SKILL("Folder Skill"),
        "/proj/.cognia/skills/flat-skill.md": SKILL("Flat Skill"),
      }
    )
    const found = await discoverDiskSkills([{ dir: "/proj/.cognia/skills", source: "project" }], fs)
    const folder = found.find((s) => s.id === "folder-skill")!
    const flat = found.find((s) => s.id === "flat-skill")!
    expect(folder.filePath.replace(/\\/g, "/")).toBe("/proj/.cognia/skills/folder-skill/SKILL.md")
    expect(folder.dir?.replace(/\\/g, "/")).toBe("/proj/.cognia/skills/folder-skill")
    expect(flat.filePath.replace(/\\/g, "/")).toBe("/proj/.cognia/skills/flat-skill.md")
    expect(flat.dir).toBeUndefined()
  })
})

describe("findDiskSkillByCanonicalId", () => {
  it("finds a skill by canonical id across project + global dirs", async () => {
    const fs = memFs(
      { "/work/.cognia/skills": ["alpha.md"], "/home/u/.cognia/skills": ["beta.md"] },
      {
        "/work/.cognia/skills/alpha.md": SKILL("Alpha"),
        "/home/u/.cognia/skills/beta.md": SKILL("Beta"),
      }
    )
    const beta = await findDiskSkillByCanonicalId(
      { cwd: "/work", home: "/home/u/.cognia" },
      "cli-disk:global:beta",
      fs
    )
    expect(beta?.id).toBe("beta")
    const missing = await findDiskSkillByCanonicalId(
      { cwd: "/work", home: "/home/u/.cognia" },
      "cli-disk:project:zzz",
      fs
    )
    expect(missing).toBeUndefined()
  })

  it("finds a skill in a reused Claude Code dir off the OS home", async () => {
    const fs = memFs(
      { "/home/u/.claude/skills": ["cc.md"] },
      { "/home/u/.claude/skills/cc.md": SKILL("CC Skill") }
    )
    const found = await findDiskSkillByCanonicalId(
      { cwd: "/work", home: "/home/u/.cognia", osHome: "/home/u" },
      "cli-disk:claude:cc",
      fs
    )
    expect(found?.id).toBe("cc")
    expect(found?.source).toBe("claude")
  })

  it("finds a skill in a reused OpenCode dir off the OS home", async () => {
    const fs = memFs(
      { "/home/u/.opencode/skills": ["oc.md"] },
      { "/home/u/.opencode/skills/oc.md": SKILL("OC Skill") }
    )
    const found = await findDiskSkillByCanonicalId(
      { cwd: "/work", home: "/home/u/.cognia", osHome: "/home/u" },
      "cli-disk:opencode:oc",
      fs
    )
    expect(found?.id).toBe("oc")
    expect(found?.source).toBe("opencode")
  })

  it("finds a skill in a project-level OpenCode dir", async () => {
    const fs = memFs(
      { "/work/.opencode/skills": ["proj-oc.md"] },
      { "/work/.opencode/skills/proj-oc.md": SKILL("Proj OC") }
    )
    const found = await findDiskSkillByCanonicalId(
      { cwd: "/work", home: "/home/u/.cognia", osHome: "/home/u" },
      "cli-disk:opencode:proj-oc",
      fs
    )
    expect(found?.id).toBe("proj-oc")
    expect(found?.source).toBe("opencode")
  })
})

describe("listSkillBundledFiles", () => {
  it("lists files recursively with SKILL.md first, then alphabetical", async () => {
    const fs = memFs(
      {
        "/s/folder": ["SKILL.md", "scripts", "notes.md"],
        "/s/folder/scripts": ["run.py"],
      },
      {
        "/s/folder/SKILL.md": "x",
        "/s/folder/notes.md": "y",
        "/s/folder/scripts/run.py": "z",
      }
    )
    const files = await listSkillBundledFiles("/s/folder", fs)
    expect(files.map((f) => f.relPath)).toEqual(["SKILL.md", "notes.md", "scripts/run.py"])
    expect(files[2].absPath.replace(/\\/g, "/")).toBe("/s/folder/scripts/run.py")
  })
})

describe("skillScanDirs", () => {
  const norm = (dirs: SkillScanDir[]) =>
    dirs.map((d) => ({ dir: d.dir.replace(/\\/g, "/"), source: d.source }))

  it("resolves the CLI's own .cognia dirs plus the reused external agent dirs", () => {
    const dirs = norm(skillScanDirs({ cwd: "/work", home: "/home/u/.cognia", osHome: "/home/u" }))
    expect(dirs).toEqual([
      { dir: "/work/.cognia/skills", source: "project" },
      { dir: "/work/.claude/skills", source: "claude-project" },
      { dir: "/work/.opencode/skills", source: "opencode" },
      { dir: "/home/u/.cognia/skills", source: "global" },
      { dir: "/home/u/.claude/skills", source: "claude" },
      { dir: "/home/u/.agents/skills", source: "codex" },
      { dir: "/home/u/.opencode/skills", source: "opencode" },
    ])
  })

  it("appends configured custom dirs after the built-in sources", () => {
    const dirs = norm(
      skillScanDirs({
        cwd: "/work",
        home: "/home/u/.cognia",
        osHome: "/home/u",
        customDirs: ["/team/skills", "  ", "/extra/skills"],
      })
    )
    expect(dirs.filter((d) => d.source === "custom")).toEqual([
      { dir: "/team/skills", source: "custom" },
      { dir: "/extra/skills", source: "custom" },
    ])
  })

  it("scans only the CLI's own .cognia dirs when external reuse is off", () => {
    const dirs = norm(
      skillScanDirs({
        cwd: "/work",
        home: "/home/u/.cognia",
        osHome: "/home/u",
        customDirs: ["/team/skills"],
        external: false,
      })
    )
    expect(dirs).toEqual([
      { dir: "/work/.cognia/skills", source: "project" },
      { dir: "/home/u/.cognia/skills", source: "global" },
    ])
  })

  it("skips Claude Code / Codex / OpenCode global dirs when the OS home is absent", () => {
    const dirs = norm(skillScanDirs({ cwd: "/work", home: "/home/u/.cognia" }))
    expect(dirs.map((d) => d.source)).toEqual(["project", "claude-project", "opencode", "global"])
  })
})

describe("skillOriginLabel", () => {
  it("maps each disk source to a readable label", () => {
    expect(skillOriginLabel("cli-disk:project:x")).toBe("project")
    expect(skillOriginLabel("cli-disk:global:x")).toBe("global")
    expect(skillOriginLabel("cli-disk:claude-project:x")).toBe("claude·proj")
    expect(skillOriginLabel("cli-disk:claude:x")).toBe("claude")
    expect(skillOriginLabel("cli-disk:codex:x")).toBe("codex")
    expect(skillOriginLabel("cli-disk:opencode:x")).toBe("opencode")
    expect(skillOriginLabel("cli-disk:custom:x")).toBe("custom")
  })

  it("returns undefined for a non-disk skill", () => {
    expect(skillOriginLabel(undefined)).toBeUndefined()
    expect(skillOriginLabel("builtin:web-search")).toBeUndefined()
  })

  it("falls back to the raw source for an unknown disk source", () => {
    expect(skillOriginLabel("cli-disk:future:x")).toBe("future")
  })
})

describe("seedDiskSkills", () => {
  it("upserts every discovered skill and counts created vs updated", async () => {
    const fs = memFs(
      { "/work/.cognia/skills": ["a.md", "b.md"] },
      {
        "/work/.cognia/skills/a.md": SKILL("Alpha"),
        "/work/.cognia/skills/b.md": SKILL("Beta"),
      }
    )
    const seen: string[] = []
    const upsert = jest.fn(async ({ canonicalId }: { canonicalId: string }) => {
      seen.push(canonicalId)
      return { created: canonicalId.endsWith("a") }
    })
    const res = await seedDiskSkills({ cwd: "/work", home: "/home/u/.cognia" }, upsert, fs)
    expect(seen.sort()).toEqual(["cli-disk:project:a", "cli-disk:project:b"])
    expect(res).toEqual({ created: 1, updated: 1 })
  })

  it("seeds reused external (Claude Code) skills too", async () => {
    const fs = memFs(
      { "/home/u/.claude/skills": ["cc.md"] },
      { "/home/u/.claude/skills/cc.md": SKILL("CC") }
    )
    const seen: string[] = []
    const upsert = jest.fn(async ({ canonicalId }: { canonicalId: string }) => {
      seen.push(canonicalId)
      return { created: true }
    })
    await seedDiskSkills({ cwd: "/work", home: "/home/u/.cognia", osHome: "/home/u" }, upsert, fs)
    expect(seen).toEqual(["cli-disk:claude:cc"])
  })

  it("seeds reused external (OpenCode) skills too", async () => {
    const fs = memFs(
      { "/home/u/.opencode/skills": ["oc.md"] },
      { "/home/u/.opencode/skills/oc.md": SKILL("OC") }
    )
    const seen: string[] = []
    const upsert = jest.fn(async ({ canonicalId }: { canonicalId: string }) => {
      seen.push(canonicalId)
      return { created: true }
    })
    await seedDiskSkills({ cwd: "/work", home: "/home/u/.cognia", osHome: "/home/u" }, upsert, fs)
    expect(seen).toEqual(["cli-disk:opencode:oc"])
  })

  it("does not abort when one upsert throws", async () => {
    const fs = memFs(
      { "/work/.cognia/skills": ["a.md", "b.md"] },
      {
        "/work/.cognia/skills/a.md": SKILL("Alpha"),
        "/work/.cognia/skills/b.md": SKILL("Beta"),
      }
    )
    const upsert = jest.fn(async ({ canonicalId }: { canonicalId: string }) => {
      if (canonicalId.endsWith("a")) throw new Error("db error")
      return { created: true }
    })
    const res = await seedDiskSkills({ cwd: "/work", home: "/home/u/.cognia" }, upsert, fs)
    expect(res.created).toBe(1) // b succeeded; a swallowed
  })
})
