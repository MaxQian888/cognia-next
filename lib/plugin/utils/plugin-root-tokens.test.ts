import { replacePluginRootTokens } from "./plugin-root-tokens"

describe("replacePluginRootTokens", () => {
  it.each([
    "${COGNIA_PLUGIN_ROOT}",
    "${CLAUDE_PLUGIN_ROOT}",
    "${CODEX_PLUGIN_ROOT}",
    "${extensionPath}",
  ])("binds %s to the installed plugin directory", (token) => {
    expect(replacePluginRootTokens(`${token}/bin/server`, "/plugins/acme")).toBe(
      "/plugins/acme/bin/server"
    )
  })

  it("recursively binds tokens without mutating the source object", () => {
    const source = {
      command: "${COGNIA_PLUGIN_ROOT}/server",
      args: ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      nested: { cwd: "${extensionPath}" },
    }

    expect(replacePluginRootTokens(source, "/plugins/acme")).toEqual({
      command: "/plugins/acme/server",
      args: ["--config", "/plugins/acme/config.json"],
      nested: { cwd: "/plugins/acme" },
    })
    expect(source.command).toBe("${COGNIA_PLUGIN_ROOT}/server")
  })

  it("preserves identity when the install root is unavailable", () => {
    const source = { command: "${COGNIA_PLUGIN_ROOT}/server" }
    expect(replacePluginRootTokens(source, "")).toBe(source)
  })
})
