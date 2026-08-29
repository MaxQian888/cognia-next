import type { SiteBindingSnapshot } from "@/types/sites"
import { parseSiteHostingManifest } from "./manifest"

const valid = {
  schemaVersion: 1,
  build: {
    install: ["pnpm", "install", "--frozen-lockfile"],
    command: ["pnpm", "build"],
    entry: "dist/server/index.js",
    assets: "dist/client",
  },
  preview: {
    command: ["pnpm", "dev"],
    url: "http://127.0.0.1:3000",
  },
  cloudflare: {
    compatibilityDate: "2026-07-18",
    compatibilityFlags: ["nodejs_compat"],
    bindings: [
      { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
      { kind: "r2", name: "FILES", resourceName: "docs-files", ownership: "managed" },
    ],
  },
}

it("parses a complete Cognia hosting manifest", () => {
  expect(parseSiteHostingManifest(JSON.stringify(valid))).toEqual(valid)
})

it("rejects absolute/escaping paths and shell-string commands", () => {
  expect(() =>
    parseSiteHostingManifest(JSON.stringify({ ...valid, build: { ...valid.build, entry: "/etc" } }))
  ).toThrow("relative")
  expect(() =>
    parseSiteHostingManifest(
      JSON.stringify({ ...valid, build: { ...valid.build, assets: "../../private" } })
    )
  ).toThrow("escape")
  expect(() =>
    parseSiteHostingManifest(
      JSON.stringify({ ...valid, build: { ...valid.build, command: "pnpm build" } })
    )
  ).toThrow("argv")
})

it("rejects secrets and invalid provider identifiers in the manifest", () => {
  expect(() =>
    parseSiteHostingManifest(JSON.stringify({ ...valid, cloudflareApiToken: "secret" }))
  ).toThrow("unsupported")
  expect(() =>
    parseSiteHostingManifest(
      JSON.stringify({
        ...valid,
        cloudflare: {
          ...valid.cloudflare,
          bindings: [{ kind: "r2", name: "bad-name", resourceName: "x", ownership: "managed" }],
        },
      })
    )
  ).toThrow("binding")
})

it("requires localhost preview URLs", () => {
  expect(() =>
    parseSiteHostingManifest(
      JSON.stringify({ ...valid, preview: { ...valid.preview, url: "https://example.com" } })
    )
  ).toThrow("localhost")
})

describe("cloudflare routes", () => {
  const base = {
    schemaVersion: 1,
    build: { command: ["pnpm", "build"], entry: "dist/index.js" },
    preview: { command: ["pnpm", "dev"], url: "http://localhost:5173" },
    cloudflare: { compatibilityDate: "2026-01-01", compatibilityFlags: [], bindings: [] },
  }
  const parse = (routes: unknown) =>
    parseSiteHostingManifest(
      JSON.stringify({ ...base, cloudflare: { ...base.cloudflare, routes } })
    )

  it("accepts host and path-glob patterns", () => {
    expect(
      parse(["example.com/api/*", "example.com/*", "*.example.com/*"]).cloudflare.routes
    ).toEqual(["example.com/api/*", "example.com/*", "*.example.com/*"])
  })

  it("is absent when the manifest does not mention routes", () => {
    expect(parseSiteHostingManifest(JSON.stringify(base)).cloudflare.routes).toBeUndefined()
  })

  it("refuses a scheme, which is the mistake people make", () => {
    // Cloudflare rejects it far from here, after an upload.
    expect(() => parse(["https://example.com/*"])).toThrow(/must not include a scheme/)
  })

  it("refuses a pattern with whitespace", () => {
    expect(() => parse(["example.com/a b"])).toThrow(/invalid/)
  })
})

it("keeps the snapshot binding kinds equal to what the manifest accepts", () => {
  // `SiteBindingSnapshot.kind` used to list kv/service/analytics-engine, none
  // of which any code path could produce. Adding one means changing both.
  const accepted = ["d1", "r2"] as const
  for (const kind of accepted) {
    const parsed = parseSiteHostingManifest(
      JSON.stringify({
        schemaVersion: 1,
        build: { command: ["pnpm", "build"], entry: "dist/index.js" },
        preview: { command: ["pnpm", "dev"], url: "http://localhost:5173" },
        cloudflare: {
          compatibilityDate: "2026-01-01",
          compatibilityFlags: [],
          bindings: [{ kind, name: "B", resourceName: "r", ownership: "managed" }],
        },
      })
    )
    const snapshotKind: SiteBindingSnapshot["kind"] = parsed.cloudflare.bindings[0]!.kind
    expect(snapshotKind).toBe(kind)
  }
  for (const kind of ["kv", "service", "analytics-engine"]) {
    expect(() =>
      parseSiteHostingManifest(
        JSON.stringify({
          schemaVersion: 1,
          build: { command: ["pnpm", "build"], entry: "dist/index.js" },
          preview: { command: ["pnpm", "dev"], url: "http://localhost:5173" },
          cloudflare: {
            compatibilityDate: "2026-01-01",
            compatibilityFlags: [],
            bindings: [{ kind, name: "B", resourceName: "r", ownership: "managed" }],
          },
        })
      )
    ).toThrow(/binding kind is unsupported/)
  }
})
