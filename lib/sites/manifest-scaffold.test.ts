import { parseSiteHostingManifest } from "./manifest"
import {
  SITE_WORKER_ENTRY_PATH,
  detectSiteProjectKind,
  detectSitePackageManager,
  scaffoldSiteHostingManifest,
  scaffoldSiteHostingManifestFromProbe,
  serializeSiteHostingManifest,
  siteScaffoldConfidence,
  type SiteProjectKind,
  type SiteProjectProbe,
} from "./manifest-scaffold"

const DATE = "2026-08-19"

function probe(overrides: Partial<SiteProjectProbe> = {}): SiteProjectProbe {
  return { entries: [], ...overrides }
}

function pkg(dependencies: Record<string, string>, dev: Record<string, string> = {}): string {
  return JSON.stringify({ name: "site", dependencies, devDependencies: dev })
}

describe("detectSiteProjectKind", () => {
  it("identifies each framework from its declared dependency", () => {
    expect(detectSiteProjectKind(probe({ packageJson: pkg({ next: "16" }) }))).toBe("next")
    expect(detectSiteProjectKind(probe({ packageJson: pkg({ astro: "5" }) }))).toBe("astro")
    expect(detectSiteProjectKind(probe({ packageJson: pkg({ "@sveltejs/kit": "2" }) }))).toBe(
      "sveltekit"
    )
    expect(detectSiteProjectKind(probe({ packageJson: pkg({}, { "@remix-run/dev": "2" }) }))).toBe(
      "remix"
    )
    expect(detectSiteProjectKind(probe({ packageJson: pkg({}, { vite: "7" }) }))).toBe("vite")
  })

  it("prefers a declared dependency over a stale config file", () => {
    const result = detectSiteProjectKind(
      probe({ entries: ["vite.config.ts"], packageJson: pkg({ next: "16" }) })
    )
    expect(result).toBe("next")
  })

  it("falls back to config-file names when nothing is declared", () => {
    expect(
      detectSiteProjectKind(probe({ entries: ["astro.config.mjs"], packageJson: pkg({}) }))
    ).toBe("astro")
    expect(
      detectSiteProjectKind(probe({ entries: ["vite.config.js"], packageJson: pkg({}) }))
    ).toBe("vite")
  })

  it("treats a package.json-less folder with index.html as a static site", () => {
    expect(detectSiteProjectKind(probe({ entries: ["index.html", "style.css"] }))).toBe("static")
  })

  it("returns node for an unrecognized package and unknown for an empty folder", () => {
    expect(detectSiteProjectKind(probe({ packageJson: pkg({ express: "5" }) }))).toBe("node")
    expect(detectSiteProjectKind(probe({ entries: ["README.md"] }))).toBe("unknown")
  })

  it("survives a malformed package.json instead of throwing", () => {
    expect(detectSiteProjectKind(probe({ packageJson: "{ not json" }))).toBe("node")
  })
})

describe("detectSitePackageManager", () => {
  it("reads the workspace lockfile in precedence order", () => {
    expect(detectSitePackageManager(probe({ rootEntries: ["pnpm-lock.yaml"] }))).toBe("pnpm")
    expect(detectSitePackageManager(probe({ rootEntries: ["yarn.lock"] }))).toBe("yarn")
    expect(detectSitePackageManager(probe({ rootEntries: ["package-lock.json"] }))).toBe("npm")
    expect(detectSitePackageManager(probe({ rootEntries: ["bun.lockb"] }))).toBe("bun")
  })

  it("prefers pnpm when several lockfiles coexist", () => {
    const result = detectSitePackageManager(
      probe({ rootEntries: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] })
    )
    expect(result).toBe("pnpm")
  })

  it("falls back to the source directory and then to pnpm", () => {
    expect(detectSitePackageManager(probe({ entries: ["yarn.lock"] }))).toBe("yarn")
    expect(detectSitePackageManager(probe())).toBe("pnpm")
  })
})

describe("scaffoldSiteHostingManifest", () => {
  const KINDS: SiteProjectKind[] = [
    "next",
    "astro",
    "sveltekit",
    "remix",
    "vite",
    "static",
    "node",
    "unknown",
  ]

  it.each(KINDS)("produces a manifest the real parser accepts for %s", (kind) => {
    const scaffold = scaffoldSiteHostingManifest(kind, {
      packageManager: "pnpm",
      compatibilityDate: DATE,
    })
    const reparsed = parseSiteHostingManifest(serializeSiteHostingManifest(scaffold.manifest))
    expect(reparsed).toEqual(scaffold.manifest)
  })

  it("always emits the generated Worker entry outside the assets directory", () => {
    const scaffold = scaffoldSiteHostingManifest("vite", {
      packageManager: "pnpm",
      compatibilityDate: DATE,
    })
    expect(scaffold.manifest.build.entry).toBe(SITE_WORKER_ENTRY_PATH)
    expect(scaffold.extraFiles).toEqual([
      { relativePath: SITE_WORKER_ENTRY_PATH, contents: expect.stringContaining("env.ASSETS") },
    ])
    expect(SITE_WORKER_ENTRY_PATH.startsWith(`${scaffold.manifest.build.assets}/`)).toBe(false)
  })

  it("uses the framework's output directory and dev-server port", () => {
    const next = scaffoldSiteHostingManifest("next", {
      packageManager: "npm",
      compatibilityDate: DATE,
    })
    expect(next.manifest.build.assets).toBe("out")
    expect(next.manifest.preview.url).toBe("http://localhost:3000")

    const svelte = scaffoldSiteHostingManifest("sveltekit", {
      packageManager: "pnpm",
      compatibilityDate: DATE,
    })
    expect(svelte.manifest.build.assets).toBe("build")
    expect(svelte.manifest.preview.url).toBe("http://localhost:5173")
  })

  it("threads the package manager into install, build, and preview argv", () => {
    const scaffold = scaffoldSiteHostingManifest("vite", {
      packageManager: "bun",
      compatibilityDate: DATE,
    })
    expect(scaffold.manifest.build.install).toEqual(["bun", "install"])
    expect(scaffold.manifest.build.command).toEqual(["bun", "run", "build"])
    expect(scaffold.manifest.preview.command).toEqual(["bun", "run", "dev"])
  })

  it("labels unrecognized projects as a template the user must edit", () => {
    expect(siteScaffoldConfidence("next")).toBe("detected")
    expect(siteScaffoldConfidence("static")).toBe("template")
    expect(siteScaffoldConfidence("node")).toBe("template")
    expect(siteScaffoldConfidence("unknown")).toBe("template")
    expect(
      scaffoldSiteHostingManifest("unknown", { packageManager: "pnpm", compatibilityDate: DATE })
        .confidence
    ).toBe("template")
  })
})

describe("scaffoldSiteHostingManifestFromProbe", () => {
  it("composes detection and generation in one call", () => {
    const scaffold = scaffoldSiteHostingManifestFromProbe(
      probe({
        entries: ["vite.config.ts", "index.html"],
        packageJson: pkg({}, { vite: "7" }),
        rootEntries: ["yarn.lock"],
      }),
      DATE
    )
    expect(scaffold.kind).toBe("vite")
    expect(scaffold.packageManager).toBe("yarn")
    expect(scaffold.confidence).toBe("detected")
    expect(scaffold.manifest.cloudflare.compatibilityDate).toBe(DATE)
  })
})

describe("serializeSiteHostingManifest", () => {
  it("writes indented JSON with a trailing newline", () => {
    const scaffold = scaffoldSiteHostingManifest("vite", {
      packageManager: "pnpm",
      compatibilityDate: DATE,
    })
    const text = serializeSiteHostingManifest(scaffold.manifest)
    expect(text.endsWith("}\n")).toBe(true)
    expect(text).toContain('\n  "build": {')
  })
})
