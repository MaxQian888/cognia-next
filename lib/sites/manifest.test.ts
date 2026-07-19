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
