import type { PluginManifest } from "@/types/plugin/plugin"
import {
  PI_PREPARE_ARGS,
  classifySkillsForPiPackage,
  discoverPiResources,
  packageFiles,
  piGlobToRegExp,
  planPiExport,
  planPiImport,
  readPiManifest,
} from "./pi-package"

const json = JSON.stringify
const files = (entries: Record<string, string>) => new Map(Object.entries(entries))
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nDo ${name}.`

describe("Pi glob matching", () => {
  it.each([
    ["skills/*", "skills/a", true],
    ["skills/*", "skills/a/b", false],
    ["skills/**", "skills/a/b", true],
    ["**/SKILL.md", "skills/a/SKILL.md", true],
    ["**/SKILL.md", "SKILL.md", true],
    ["prompts/{a,b}.md", "prompts/b.md", true],
    ["prompts/[!x]*.md", "prompts/y.md", true],
    ["prompts/?.md", "prompts/ab.md", false],
  ])("%s matches %s → %s", (pattern, path, expected) => {
    expect(piGlobToRegExp(pattern).test(path)).toBe(expected)
  })
})

describe("Pi resource discovery", () => {
  it("reads only array-of-string resource fields", () => {
    expect(readPiManifest({ name: "x" })).toBeNull()
    expect(readPiManifest({ pi: { skills: ["./s"], prompts: "./p", themes: [1] } })).toEqual({
      skills: ["./s"],
    })
  })

  it("uses conventional directories with Pi's rules when there is no pi manifest", () => {
    const discovery = discoverPiResources(
      files({
        "package.json": "{}",
        "extensions/tool.ts": "export default () => {}",
        "extensions/group/index.ts": "export default () => {}",
        "extensions/group/helper.ts": "",
        "extensions/node_modules/dep/index.js": "",
        "skills/review/SKILL.md": skill("review"),
        "skills/review/nested/SKILL.md": skill("nested"),
        "skills/loose.md": skill("loose"),
        "skills/deep/notes.md": "not a skill",
        "prompts/fix.md": "Fix $1",
        "prompts/sub/more.md": "More",
        "themes/dark.json": "{}",
        "themes/.hidden.json": "{}",
      }),
      {}
    )
    expect(discovery.manifest).toBeNull()
    expect(discovery.resources).toEqual({
      extensions: ["extensions/tool.ts", "extensions/group/index.ts"],
      skills: ["skills/loose.md", "skills/review/SKILL.md"],
      prompts: ["prompts/fix.md", "prompts/sub/more.md"],
      themes: ["themes/dark.json"],
    })
  })

  it("follows manifest entries, globs and override patterns and ignores missing keys", () => {
    const tree = files({
      "src/skills/a/SKILL.md": skill("a"),
      "src/skills/b/SKILL.md": skill("b"),
      "src/skills/c/SKILL.md": skill("c"),
      "skills/ignored/SKILL.md": skill("ignored"),
      "src/ext.ts": "",
    })
    const discovery = discoverPiResources(tree, {
      pi: { skills: ["./src/skills/*", "!b", "./missing"], extensions: ["./src/ext.ts"] },
    })
    expect(discovery.resources.skills).toEqual(["src/skills/a/SKILL.md", "src/skills/c/SKILL.md"])
    expect(discovery.resources.extensions).toEqual(["src/ext.ts"])
    // A pi manifest disables conventional discovery for every resource type.
    expect(discovery.resources.prompts).toEqual([])
    expect(discovery.missing).toEqual([{ type: "skills", entry: "./missing" }])
  })

  it("reports ignore files Pi would apply inside walked resource directories", () => {
    expect(
      discoverPiResources(files({ "skills/a/SKILL.md": skill("a"), "skills/.gitignore": "a" }), {})
        .ignoreFiles
    ).toEqual(["skills/.gitignore"])
    expect(
      discoverPiResources(files({ "skills/a/SKILL.md": skill("a"), ".gitignore": "dist" }), {})
        .ignoreFiles
    ).toEqual([])
  })
})

describe("Pi import planning", () => {
  const pkg = (extra: Record<string, unknown> = {}, tree: Record<string, string> = {}) =>
    files({
      "package.json": json({
        name: "@acme/pi-tools",
        version: "1.2.0",
        description: "Tools",
        keywords: ["pi-package", "acme"],
        ...extra,
      }),
      "skills/review/SKILL.md": skill("review"),
      "prompts/fix.md": "---\ndescription: Fix it\nargument-hint: <file>\n---\nFix $1 now.",
      "extensions/tools.ts":
        'export default (pi) => { pi.registerTool({}); pi.registerMcpServer({}); pi.on("tool_call", () => {}) }',
      "themes/dark.json": "{}",
      ...tree,
    })

  it("retains the whole package and converts skills and prompts", () => {
    const plan = planPiImport(
      pkg({
        dependencies: { zod: "^3.0.0", "@earendil-works/pi-ai": "*" },
        peerDependencies: { "@earendil-works/pi-coding-agent": "^1.0.0" },
        scripts: { postinstall: "node setup.js", test: "vitest" },
      })
    )
    expect(plan.piPackage).toEqual({
      id: "acme-pi-tools",
      name: "@acme/pi-tools",
      description: "Tools",
      path: ".",
      minPiVersion: "1.0.0",
      prepare: {
        program: "npm",
        args: [...PI_PREPARE_ARGS],
        marker: "node_modules/.package-lock.json",
      },
    })
    expect(plan.skillFiles).toEqual(["skills/review/SKILL.md"])
    expect(plan.promptSkills).toEqual([
      {
        id: "fix",
        name: "fix",
        description: "Fix it",
        invocationPolicy: "explicit",
        source: { kind: "inline", markdown: "Fix $1 now." },
      },
    ])
    expect(plan.contextual).toBe(true)
    expect(plan.issues.blocking).toEqual([])
    const warnings = plan.issues.warnings
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n")
    expect(warnings).toMatch(/registerMcpServer; registerTool; events tool_call/)
    expect(warnings).toMatch(/No hostedSession block was generated/)
    expect(warnings).toMatch(/dependencies.@earendil-works\/pi-ai: .*peerDependencies/)
    expect(warnings).toMatch(/scripts.postinstall: Lifecycle scripts never run/)
    expect(warnings).not.toMatch(/scripts.test/)
    expect(warnings).toMatch(/argument-hint/)
    expect(plan.issues.converted.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["themes/dark.json", "package.json", "prompts/fix.md"])
    )
  })

  it("omits prepare without runtime dependencies and reports Pi-ignored manifest keys", () => {
    const plan = planPiImport(pkg({ pi: { skills: "./skills", image: "x.png", extra: true } }))
    expect(plan.piPackage.prepare).toBeUndefined()
    expect(plan.skillFiles).toEqual([])
    expect(plan.issues.warnings.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "package.json.pi.skills",
        "package.json.pi.image",
        "package.json.pi.extra",
      ])
    )
  })

  it.each([
    [{ "dist/index.js": "built" }, {}, "dist/index.js"],
    [{}, { pi: { extensions: ["./dist/extension.js"] } }, "package.json.pi.extensions"],
    [{ "skills/.ignore": "x" }, {}, "skills/.ignore"],
    [{ "prompts/bad.md": "---\nmodel: x\n---\nBody" }, {}, "prompts/bad.md"],
  ])("blocks what cannot be retained or converted exactly %#", (tree, extra, path) => {
    const plan = planPiImport(pkg(extra, tree))
    expect(plan.issues.blocking.map((issue) => issue.path)).toContain(path)
  })

  it("requires a named package", () => {
    expect(() => planPiImport(files({ "package.json": json({ pi: {} }) }))).toThrow(/name/)
    expect(() => planPiImport(files({}))).toThrow(/package.json/)
  })
})

describe("Pi export planning", () => {
  const manifest = (extra: Partial<PluginManifest> = {}) =>
    ({
      id: "acme-tools",
      name: "Acme Tools",
      version: "1.0.0",
      description: "Tools",
      type: "frontend",
      capabilities: ["skills"],
      keywords: ["acme"],
      ...extra,
    }) as PluginManifest

  it("creates a package for plain skills without clobbering author keywords", () => {
    const plan = planPiExport({
      manifest: manifest(),
      files: files({}),
      exported: files({ "skills/review/SKILL.md": skill("review") }),
      exportedCopies: [],
      generatedEntry: "",
    })
    expect(plan.issues.blocking).toEqual([])
    expect(JSON.parse(plan.files.get("package.json")!)).toMatchObject({
      name: "acme-tools",
      keywords: ["acme", "pi-package"],
      pi: { skills: ["./skills"] },
    })
  })

  it("writes a retained package back byte-for-byte and merges new skills into pi.skills", () => {
    const pkgJson = json({
      name: "@acme/pi-tools",
      keywords: ["x"],
      pi: { skills: ["./src/skills"] },
    })
    const source = files({
      "plugin.json": "{}",
      "dist/index.js": "GENERATED",
      ".env": "\n",
      "package.json": pkgJson,
      "src/skills/a/SKILL.md": skill("a"),
      "extensions/x.ts": "code",
      "assets/logo.png": "",
    })
    const plan = planPiExport({
      manifest: manifest({
        capabilities: ["skills", "pi-package"],
        piPackages: [
          { id: "pi-tools", name: "@acme/pi-tools", path: ".", hostedSession: { extensions: [] } },
        ],
      }),
      files: source,
      exported: files({ "skills/extra/SKILL.md": skill("extra") }),
      exportedCopies: [],
      binaryPaths: new Set(["assets/logo.png"]),
      generatedEntry: "GENERATED",
    })
    expect(plan.issues.blocking).toEqual([])
    expect(plan.files.has("plugin.json")).toBe(false)
    expect(plan.files.has("dist/index.js")).toBe(false)
    expect(plan.files.has(".env")).toBe(false)
    expect(plan.files.get("extensions/x.ts")).toBe("code")
    expect(plan.copies).toEqual([{ from: "assets/logo.png", to: "assets/logo.png" }])
    expect(JSON.parse(plan.files.get("package.json")!)).toMatchObject({
      keywords: ["x", "pi-package"],
      pi: { skills: ["./src/skills", "./skills/extra"] },
    })
    expect(plan.issues.warnings.map((issue) => issue.path)).toContain(
      "piPackages.pi-tools.hostedSession"
    )
  })

  it("blocks several packages, bundled host packages and overwrites", () => {
    const two = planPiExport({
      manifest: manifest({
        piPackages: [
          { id: "a", name: "a", path: "a" },
          { id: "b", name: "b", path: "b" },
        ],
      }),
      files: files({}),
      exported: new Map(),
      exportedCopies: [],
      generatedEntry: "",
    })
    expect(two.issues.blocking.map((issue) => issue.path)).toEqual(["piPackages"])
    const host = planPiExport({
      manifest: manifest({ piPackages: [{ id: "a", name: "a", path: "vendor/pi" }] }),
      files: files({
        "vendor/pi/package.json": json({ name: "a", dependencies: { typebox: "*" } }),
        "vendor/pi/skills/x/SKILL.md": "different",
      }),
      exported: files({ "skills/x/SKILL.md": skill("x") }),
      exportedCopies: [],
      generatedEntry: "",
    })
    expect(host.issues.blocking.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["package.json.dependencies.typebox", "skills/x/SKILL.md"])
    )
  })

  it("classifies skills the retained package already delivers", () => {
    const source = files({
      "package.json": json({ name: "p" }),
      "skills/review/SKILL.md": skill("review"),
      "prompts/fix.md": "Fix it",
    })
    const result = classifySkillsForPiPackage({
      skills: [
        {
          id: "review",
          name: "review",
          description: "",
          source: { kind: "inline", markdown: "Do review." },
        },
        {
          id: "fix",
          name: "fix",
          description: "",
          source: { kind: "inline", markdown: "Changed" },
        },
        {
          id: "bundle",
          name: "b",
          description: "",
          source: { kind: "local-bundle", path: "skills/review" },
        },
        { id: "new", name: "new", description: "", source: { kind: "inline", markdown: "New" } },
      ],
      files: source,
      piPackage: { id: "p", name: "p", path: "." },
    })
    expect(result.delivered).toEqual(["review", "bundle"])
    expect(result.remaining.map((skill) => skill.id)).toEqual(["new"])
    expect(result.collisions.map((issue) => issue.path)).toEqual(["skills.fix"])
  })

  it("re-roots package files", () => {
    expect([...packageFiles(files({ "a/b.txt": "1", "c.txt": "2" }), "a").keys()]).toEqual([
      "b.txt",
    ])
    expect(packageFiles(files({ "c.txt": "2" }), ".").get("c.txt")).toBe("2")
  })
})
