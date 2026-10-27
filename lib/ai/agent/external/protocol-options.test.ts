import { BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS } from "@cognia/agent-config-types/external-agent-capability"
import { externalProtocolOptions } from "./protocol-options"
import {
  __resetPluginProtocolAdaptersForTesting,
  registerPluginProtocolAdapter,
  unregisterPluginProtocolAdaptersByPlugin,
} from "./protocol-adapter"

const values = (current?: string) => externalProtocolOptions(current).map((o) => o.value)

describe("externalProtocolOptions", () => {
  afterEach(() => __resetPluginProtocolAdaptersForTesting())

  it("offers every protocol that has a registered adapter", () => {
    expect(values()).toEqual(BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS)
    expect(values().sort()).toEqual([
      "a2a",
      "acp",
      "aider-cli",
      "codebuff-sdk",
      "codex-app-server",
      "codex-siwc-app-server",
      "continue-cli",
      "crush-http",
      "dsh-sdk",
      "openclaude-cli",
      "opencode",
      "opencode-v2",
      "pi-rpc",
      "rovo-http",
    ])
  })

  it.each([
    { value: "opencode-v2", label: "OpenCode V2 (HTTP + SSE)" },
    { value: "opencode", label: "OpenCode (HTTP + SSE)" },
  ])("keeps the registered OpenCode route $value selectable when editing it", (route) => {
    const expected = { ...route, selectable: true }
    expect(externalProtocolOptions()).toContainEqual(expected)
    const editing = externalProtocolOptions(route.value)
    expect(editing).toContainEqual(expected)
    expect(editing.filter((option) => option.value === route.value)).toEqual([expected])
    expect(editing).toHaveLength(BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS.length)
  })

  it("no longer offers protocols nothing can speak", () => {
    // `http`, `websocket` and `custom` were listed as "coming soon" in two
    // dialogs. `protocolAdapterRegistry.register("http", …)` has been commented
    // out since the module was written, so picking one produced an agent that
    // failed at connect with "no adapter for protocol".
    for (const legacy of ["http", "websocket", "custom"]) {
      expect(values()).not.toContain(legacy)
    }
  })

  it("offers the three protocols the old hand-written lists omitted", () => {
    for (const missing of ["codex-app-server", "pi-rpc", "dsh-sdk"]) {
      expect(values()).toContain(missing)
    }
  })

  it("keeps a stored legacy value visible but unpickable", () => {
    const options = externalProtocolOptions("websocket")
    // Dropping it would silently rewrite the user's config: a controlled
    // <Select> whose value is not among its items clears itself.
    expect(options[0]).toEqual({
      value: "websocket",
      label: "websocket",
      selectable: false,
      reasonKey: "legacyProtocolUnavailable",
    })
    expect(options).toHaveLength(BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS.length + 1)
  })

  /**
   * A contributed adapter has to be reachable from the picker. Offering it only
   * when the form already held the value made hand-editing a stored config the
   * only way to ever select one.
   */
  it("offers a registered plugin protocol even when nothing selected it yet", () => {
    registerPluginProtocolAdapter("acme:demo", () => ({}) as never, { pluginId: "acme" })
    expect(externalProtocolOptions()).toContainEqual({
      value: "acme:demo",
      label: "acme:demo",
      selectable: true,
      reasonKey: "pluginProtocolContributed",
    })
  })

  it("keeps a registered plugin protocol selectable and says where it came from", () => {
    registerPluginProtocolAdapter("acme:demo", () => ({}) as never, { pluginId: "acme" })
    const options = externalProtocolOptions("acme:demo")
    expect(options).toContainEqual({
      value: "acme:demo",
      label: "acme:demo",
      selectable: true,
      reasonKey: "pluginProtocolContributed",
    })
    expect(options.filter((o) => o.value === "acme:demo")).toHaveLength(1)
  })

  /** The contributing plugin is disabled or uninstalled: keep it, refuse it. */
  it("refuses a plugin protocol whose adapter is no longer registered", () => {
    registerPluginProtocolAdapter("acme:demo", () => ({}) as never, { pluginId: "acme" })
    expect(externalProtocolOptions("acme:demo")).toContainEqual(
      expect.objectContaining({ value: "acme:demo", selectable: true })
    )
    expect(unregisterPluginProtocolAdaptersByPlugin("acme")).toBe(1)
    expect(values()).not.toContain("acme:demo")
    const options = externalProtocolOptions("acme:demo")
    expect(options[0]).toEqual({
      value: "acme:demo",
      label: "acme:demo",
      selectable: false,
      reasonKey: "legacyProtocolUnavailable",
    })
    expect(options.filter((option) => option.value === "acme:demo")).toHaveLength(1)
  })

  it("preserves an unrecognized value without letting it be re-picked", () => {
    const options = externalProtocolOptions("telepathy")
    expect(options[0].value).toBe("telepathy")
    expect(options[0].selectable).toBe(false)
  })

  it("does not duplicate a current value that is already a built-in", () => {
    expect(values("acp")).toHaveLength(BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS.length)
    expect(values("acp").filter((v) => v === "acp")).toHaveLength(1)
  })

  it("labels every built-in protocol", () => {
    for (const option of externalProtocolOptions()) {
      expect(option.label.length).toBeGreaterThan(option.value.length - 1)
      expect(option.reasonKey).toBeUndefined()
    }
  })
})
