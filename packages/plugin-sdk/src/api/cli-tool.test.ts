import * as sdk from "./cli-tool"
import type {
  PluginCliArgvToken,
  PluginCliBinaryRef,
  PluginCliCwdPolicy,
  PluginCliOutputParse,
  PluginCliToolDef,
} from "./cli-tool"

describe("plugin-sdk api/cli-tool", () => {
  it("exposes portable CLI-tool authoring and preview helpers", () => {
    expect(typeof sdk.defineCliTool).toBe("function")
    expect(typeof sdk.buildArgv).toBe("function")
    expect(typeof sdk.resolveCwd).toBe("function")
    expect(typeof sdk.parseOutput).toBe("function")
    expect(typeof sdk.CliTemplateError).toBe("function")
  })

  it("defineCliTool is a typesafe identity function", () => {
    const def = sdk.defineCliTool({
      name: "search_files",
      description: "Search workspace files.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      binary: { kind: "requires", name: "rg" },
      argv: [{ literal: "--json" }, { param: "query" }],
      outputParse: "json",
    })

    expect(def.name).toBe("search_files")
    expect(def.argv).toHaveLength(2)
  })

  it("assertConfinedPathParams accepts in-base paths and no-ops on absence", () => {
    const names = ["path"]
    expect(() => sdk.assertConfinedPathParams({ path: "a/b" }, names, "/ws")).not.toThrow()
    expect(() => sdk.assertConfinedPathParams({ path: "/ws/a" }, names, "/ws")).not.toThrow()
    // Omitted / empty / unlisted params pass; an empty names list no-ops.
    expect(() => sdk.assertConfinedPathParams({}, names, "/ws")).not.toThrow()
    expect(() => sdk.assertConfinedPathParams({ path: "x" }, names, "/ws")).not.toThrow()
    expect(() => sdk.assertConfinedPathParams({ path: "/etc" }, [], "/ws")).not.toThrow()
    expect(() => sdk.assertConfinedPathParams({ path: "/etc" }, undefined, "/ws")).not.toThrow()
    // Array params are checked elementwise.
    expect(() =>
      sdk.assertConfinedPathParams({ paths: ["a", "/ws/b"] }, ["paths"], "/ws")
    ).not.toThrow()
  })

  it("assertConfinedPathParams rejects escapes, non-strings, and missing base", () => {
    const names = ["path"]
    for (const path of ["/etc/passwd", "../up", "a/../..", "C:/Windows/System32"]) {
      expect(() => sdk.assertConfinedPathParams({ path }, names, "/ws")).toThrow(
        sdk.CliTemplateError
      )
    }
    expect(() => sdk.assertConfinedPathParams({ path: 42 }, names, "/ws")).toThrow(
      sdk.CliTemplateError
    )
    expect(() =>
      sdk.assertConfinedPathParams({ paths: ["ok", "evil/../.."] }, ["paths"], "/ws")
    ).toThrow(sdk.CliTemplateError)
    // No base → fail closed.
    expect(() => sdk.assertConfinedPathParams({ path: "x" }, names, undefined)).toThrow(
      sdk.CliTemplateError
    )
  })

  it("assertConfinedPathParams denies credential-shaped paths inside the base", () => {
    const names = ["path"]
    for (const path of [
      ".ssh",
      "sub/.aws/credentials",
      ".ssh/id_ed25519",
      "deep/dir/.git-credentials",
      "x/.config/gh",
      "known_hosts",
      ".netrc",
      "fixtures/.gnupg",
      ".cognia/sessions.db",
    ]) {
      expect(() => sdk.assertConfinedPathParams({ path }, names, "/ws")).toThrow(
        sdk.CliTemplateError
      )
    }
    // Benign lookalikes pass — the deny is segment/basename exact.
    expect(() =>
      sdk.assertConfinedPathParams({ path: "src/.ssh-config-notes.txt" }, names, "/ws")
    ).not.toThrow()
    expect(() =>
      sdk.assertConfinedPathParams({ path: "docs/credentials-guide.md" }, names, "/ws")
    ).not.toThrow()
  })

  it("isProtectedCliPath mirrors the sidecar deny list", () => {
    for (const p of [
      "/home/u/.ssh",
      "C:/Users/u/.aws/credentials",
      "/w/repo/.docker/config.json",
      "/w/.config/gcloud/application_default_credentials.json",
      "/w/.config/gh/hosts.yml",
      "/w/foo/known_hosts",
    ]) {
      expect(sdk.isProtectedCliPath(p)).toBe(true)
    }
    for (const p of ["/w/src/.ssh-notes.md", "/w/lib/credentials.ts", "/w/.config/gh-pages"]) {
      expect(sdk.isProtectedCliPath(p)).toBe(false)
    }
  })

  it("re-exports CLI manifest and executor types", () => {
    const assertTypes = <
      _T extends
        | PluginCliToolDef
        | PluginCliBinaryRef
        | PluginCliArgvToken
        | PluginCliOutputParse
        | PluginCliCwdPolicy,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
