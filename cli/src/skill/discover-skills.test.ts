/**
 * @jest-environment node
 */
import {
  discoverDiskSkills,
  findDiskSkillByCanonicalId,
  listSkillBundledFiles,
  seedDiskSkills,
  skillScanDirs,
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
      "/work",
      "/home/u/.cognia",
      "cli-disk:global:beta",
      fs
    )
    expect(beta?.id).toBe("beta")
    const missing = await findDiskSkillByCanonicalId(
      "/work",
      "/home/u/.cognia",
      "cli-disk:project:zzz",
      fs
    )
    expect(missing).toBeUndefined()
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
  it("resolves project .cognia/skills and global <home>/skills", () => {
    const dirs = skillScanDirs("/work", "/home/u/.cognia")
    expect(dirs[0]).toEqual({ dir: expect.stringContaining("skills"), source: "project" })
    expect(dirs[0].dir.replace(/\\/g, "/")).toBe("/work/.cognia/skills")
    expect(dirs[1].dir.replace(/\\/g, "/")).toBe("/home/u/.cognia/skills")
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
    const res = await seedDiskSkills("/work", "/home/u/.cognia", upsert, fs)
    expect(seen.sort()).toEqual(["cli-disk:project:a", "cli-disk:project:b"])
    expect(res).toEqual({ created: 1, updated: 1 })
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
    const res = await seedDiskSkills("/work", "/home/u/.cognia", upsert, fs)
    expect(res.created).toBe(1) // b succeeded; a swallowed
  })
})
