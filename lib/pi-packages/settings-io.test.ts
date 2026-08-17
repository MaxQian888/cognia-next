import {
  extractPiPackages,
  projectSettingsPath,
  readProjectPiPackages,
  readUserPiPackages,
  writeProjectPiPackages,
  writeUserPiPackages,
  type PiSettingsIoDeps,
} from "./settings-io"

function deps(overrides: Partial<PiSettingsIoDeps> = {}): PiSettingsIoDeps {
  return {
    readAgentConfig: jest.fn(async () => ({
      exists: true,
      parsed: {} as unknown,
      parseError: undefined,
    })),
    writeAgentConfig: jest.fn(async () => ({ path: "/s.json" })),
    readTextFile: jest.fn(async () => "{}"),
    writeTextFile: jest.fn(async () => {}),
    exists: jest.fn(async () => true),
    ...overrides,
  }
}

describe("extractPiPackages", () => {
  it("accepts both the string and object entry forms", () => {
    const { packages } = extractPiPackages({
      packages: ["npm:a", { source: "npm:b", autoload: false, skills: [] }],
    })
    expect(packages).toEqual(["npm:a", { source: "npm:b", autoload: false, skills: [] }])
  })

  /** The allowlist: nothing outside `packages` may reach a caller. */
  it("returns only packages, never any other settings key", () => {
    const result = extractPiPackages({
      packages: ["npm:a"],
      defaultProvider: "openai-codex",
      customProviderApiKey: "sk-secret",
    })
    expect(result.packages).toEqual(["npm:a"])
    expect(JSON.stringify(result)).not.toContain("sk-secret")
    expect(JSON.stringify(result)).not.toContain("openai-codex")
  })

  it("keeps only the six fields Pi declares, and says what it dropped", () => {
    const { packages, warnings } = extractPiPackages({
      packages: [{ source: "npm:a", autoload: false, themes: ["x"], madeUpField: 1 }],
    })
    expect(packages[0]).toEqual({ source: "npm:a", autoload: false, themes: ["x"] })
    expect(warnings.join(" ")).toContain("madeUpField")
  })

  it("skips entries that are neither string nor { source } object", () => {
    const { packages, warnings } = extractPiPackages({ packages: [42, { nope: true }, "npm:ok"] })
    expect(packages).toEqual(["npm:ok"])
    expect(warnings).toHaveLength(2)
  })

  it("ignores a non-array packages value", () => {
    const { packages, warnings } = extractPiPackages({ packages: "npm:a" })
    expect(packages).toEqual([])
    expect(warnings.join(" ")).toContain("not an array")
  })

  it("is empty for a settings object with no packages key", () => {
    expect(extractPiPackages({ theme: "ocean" })).toEqual({ packages: [], warnings: [] })
  })

  it("is empty for a non-object", () => {
    expect(extractPiPackages(null).packages).toEqual([])
    expect(extractPiPackages(["a"]).packages).toEqual([])
  })

  it("drops a filter array containing non-strings rather than trusting it", () => {
    const { packages } = extractPiPackages({ packages: [{ source: "npm:a", skills: [1, 2] }] })
    expect(packages[0]).toEqual({ source: "npm:a" })
  })
})

describe("readUserPiPackages", () => {
  it("reads the packages array", async () => {
    const result = await readUserPiPackages(
      deps({
        readAgentConfig: jest.fn(async () => ({
          exists: true,
          parsed: { packages: ["npm:a"], theme: "ocean" },
        })),
      })
    )
    expect(result.packages).toEqual(["npm:a"])
    expect(result.missing).toBe(false)
    expect(result.unparseable).toBe(false)
  })

  it("reports a missing settings file rather than throwing", async () => {
    const result = await readUserPiPackages(
      deps({
        readAgentConfig: jest.fn(async () => ({
          exists: false,
          parsed: null,
          parseError: undefined,
        })),
      })
    )
    expect(result.missing).toBe(true)
    expect(result.packages).toEqual([])
  })

  it("flags an unparseable file so callers refuse to write", async () => {
    const result = await readUserPiPackages(
      deps({
        readAgentConfig: jest.fn(async () => ({
          exists: true,
          parsed: null,
          parseError: "bad json",
        })),
      })
    )
    expect(result.unparseable).toBe(true)
  })

  it("turns an IPC failure into a warning, not an exception", async () => {
    const result = await readUserPiPackages(
      deps({
        readAgentConfig: jest.fn(async () => {
          throw new Error("agent directory missing: /x (agent not installed?)")
        }),
      })
    )
    expect(result.missing).toBe(true)
    expect(result.warnings.join(" ")).toContain("agent not installed")
  })
})

describe("readProjectPiPackages", () => {
  it("reads <cwd>/.pi/settings.json", async () => {
    const readTextFile = jest.fn(async () => JSON.stringify({ packages: ["npm:p"] }))
    const result = await readProjectPiPackages("/repo", deps({ readTextFile }))
    expect(readTextFile).toHaveBeenCalledWith("/repo/.pi/settings.json")
    expect(result.packages).toEqual(["npm:p"])
  })

  it("is missing when the file is absent", async () => {
    const result = await readProjectPiPackages(
      "/repo",
      deps({ exists: jest.fn(async () => false) })
    )
    expect(result.missing).toBe(true)
  })

  it("flags unparseable JSON", async () => {
    const result = await readProjectPiPackages(
      "/repo",
      deps({ readTextFile: jest.fn(async () => "{ not json") })
    )
    expect(result.unparseable).toBe(true)
  })
})

describe("writeUserPiPackages", () => {
  it("preserves every other settings key", async () => {
    const writeAgentConfig = jest.fn(async () => ({ path: "/s.json" }))
    await writeUserPiPackages(["npm:new"], {
      ...deps({ writeAgentConfig }),
      readAgentConfig: jest.fn(async () => ({
        exists: true,
        parsed: {
          packages: ["npm:old"],
          theme: "ocean",
          compaction: { keepRecentTokens: 24000 },
        } as unknown,
        parseError: undefined,
      })),
    })
    expect(writeAgentConfig).toHaveBeenCalledWith("pi", {
      packages: ["npm:new"],
      theme: "ocean",
      compaction: { keepRecentTokens: 24000 },
    })
  })

  /**
   * The guard that matters: serializing `{}` over a settings file that merely
   * failed to parse would wipe every preference the user has.
   */
  it("refuses to write over an existing but unparseable file", async () => {
    const writeAgentConfig = jest.fn(async () => ({ path: "/s.json" }))
    await expect(
      writeUserPiPackages(["npm:new"], {
        ...deps({ writeAgentConfig }),
        readAgentConfig: jest.fn(async () => ({ exists: true, parsed: null, parseError: "bad" })),
      })
    ).rejects.toThrow(/refusing to overwrite/)
    expect(writeAgentConfig).not.toHaveBeenCalled()
  })

  it("writes a fresh file when settings do not exist yet", async () => {
    const writeAgentConfig = jest.fn(async () => ({ path: "/s.json" }))
    await writeUserPiPackages(["npm:new"], {
      ...deps({ writeAgentConfig }),
      readAgentConfig: jest.fn(async () => ({
        exists: false,
        parsed: null,
        parseError: undefined,
      })),
    })
    expect(writeAgentConfig).toHaveBeenCalledWith("pi", { packages: ["npm:new"] })
  })
})

describe("writeProjectPiPackages", () => {
  it("preserves other keys and writes pretty JSON", async () => {
    const writeTextFile = jest.fn(async () => {})
    await writeProjectPiPackages("/repo", ["npm:p"], {
      ...deps({ writeTextFile }),
      readTextFile: jest.fn(async () =>
        JSON.stringify({ compaction: { keepRecentTokens: 24000 } })
      ),
    })
    const [path, contents] = writeTextFile.mock.calls[0] as unknown as [string, string]
    expect(path).toBe("/repo/.pi/settings.json")
    expect(JSON.parse(contents)).toEqual({
      compaction: { keepRecentTokens: 24000 },
      packages: ["npm:p"],
    })
    expect(contents.endsWith("\n")).toBe(true)
  })

  it("refuses to overwrite an unparseable project file", async () => {
    await expect(
      writeProjectPiPackages("/repo", ["npm:p"], {
        ...deps(),
        readTextFile: jest.fn(async () => "{ broken"),
      })
    ).rejects.toThrow(/refusing to overwrite/)
  })

  it("creates the file when the project has no settings yet", async () => {
    const writeTextFile = jest.fn(async () => {})
    await writeProjectPiPackages("/repo", ["npm:p"], {
      ...deps({ writeTextFile, exists: jest.fn(async () => false) }),
    })
    const [, contents] = writeTextFile.mock.calls[0] as unknown as [string, string]
    expect(JSON.parse(contents)).toEqual({ packages: ["npm:p"] })
  })
})

describe("projectSettingsPath", () => {
  it("is always <cwd>/.pi/settings.json", () => {
    expect(projectSettingsPath("/repo")).toBe("/repo/.pi/settings.json")
    expect(projectSettingsPath("/repo/")).toBe("/repo/.pi/settings.json")
  })
})
