/**
 * @jest-environment jsdom
 */
/**
 * Normalization of the legacy authoring surfaces.
 *
 * The `onChatRequest` case is the one that changes behaviour: the old
 * dispatcher ran every plugin against the SAME `messages` array and returned
 * the last successful result, so with two plugins installed one of them
 * silently did nothing. These tests pin the pipeline semantics that replaces it.
 */

import {
  createInterceptorRegistration,
  interceptorFromChatMiddleware,
  interceptorsFromLegacyHooks,
  legacyHookPointId,
  NORMALIZED_LEGACY_HOOKS,
} from "./normalize"
import { dispatchTransform } from "./dispatch"
import { requireInterceptorPoint } from "./points"
import { setInterceptorIdentityResolver, __resetInterceptorIdentityForTesting } from "./identity"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"
import type { InterceptorRegistration } from "./types"

beforeEach(() => {
  usePluginStore.setState({ plugins: {} } as never)
  __resetInterceptorIdentityForTesting()
})

describe("createInterceptorRegistration", () => {
  it("stamps identity and trust from the host, ignoring anything the caller could claim", () => {
    usePluginStore.setState({
      plugins: { p1: { id: "p1", status: "enabled", source: "builtin" } },
    } as never)
    setInterceptorIdentityResolver(() => ({
      pluginInstanceId: "p1#3",
      generation: 3,
      realmId: "session:s1",
      runtime: "hybrid",
    }))

    const record = createInterceptorRegistration({
      pluginId: "p1",
      pointId: "model.request.prepare",
      semantic: "transform",
      handler: (() => undefined) as never,
      source: "interceptors",
    })

    expect(record.generation).toBe(3)
    expect(record.realmId).toBe("session:s1")
    expect(record.pluginInstanceId).toBe("p1#3")
    expect(record.trustTier).toBe("builtin")
    expect(record.runtime).toBe("hybrid")
  })

  it("clamps a requested timeout down to the point's ceiling but never up", () => {
    const ceiling = requireInterceptorPoint("model.stream.transform").timeoutCeilingMs
    const greedy = createInterceptorRegistration({
      pluginId: "p1",
      pointId: "model.stream.transform",
      semantic: "transform",
      handler: (() => undefined) as never,
      timeoutMs: ceiling * 10,
      source: "interceptors",
    })
    expect(greedy.timeoutMs).toBe(ceiling)

    const modest = createInterceptorRegistration({
      pluginId: "p1",
      pointId: "model.stream.transform",
      semantic: "transform",
      handler: (() => undefined) as never,
      timeoutMs: 50,
      source: "interceptors",
    })
    expect(modest.timeoutMs).toBe(50)
  })

  it("derives a stable id when the surface supplies one", () => {
    const record = createInterceptorRegistration({
      pluginId: "p1",
      pointId: "model.request.prepare",
      semantic: "transform",
      handler: (() => undefined) as never,
      source: "interceptors",
      registrationId: "p1:pinned",
    })
    expect(record.registrationId).toBe("p1:pinned")
  })
})

describe("interceptorFromChatMiddleware", () => {
  it("forwards the request the middleware holds, so a rewrite actually lands", async () => {
    const seen: string[] = []
    const record = interceptorFromChatMiddleware({
      pluginId: "p1",
      fullId: "p1:mw",
      priority: 5,
      timeoutMs: 1_000,
      fn: async (req, next) => {
        seen.push((req as unknown as { model: string }).model)
        return next()
      },
    })

    expect(record.pointId).toBe("model.request.invoke")
    expect(record.semantic).toBe("around")
    expect(record.order.priority).toBe(5)
    expect(record.registrationId).toBe("p1:mw")

    const handler = record.handler as unknown as (
      input: unknown,
      next: (value?: unknown) => Promise<string>
    ) => Promise<string>
    const result = await handler({ model: "m1" }, async (value) => JSON.stringify(value ?? null))
    expect(seen).toEqual(["m1"])
    expect(result).toBe('{"model":"m1"}')
  })
})

describe("interceptorsFromLegacyHooks", () => {
  const chainOf = (records: InterceptorRegistration[], pointId: string) =>
    records.filter((entry) => entry.pointId === pointId)

  it("normalizes only the hooks whose shape is genuinely an interceptor", () => {
    const hooks = {
      onChatRequest: () => undefined,
      onBuildOptions: () => undefined,
      onPostToolUse: () => undefined,
      // Guard-shaped: folding it into a transform chain would let a later
      // plugin turn an earlier plugin's `deny` back into `allow`.
      onPreToolUse: () => undefined,
      onEnable: () => undefined,
    } as unknown as PluginHooksAll

    const records = interceptorsFromLegacyHooks("p1", hooks)
    expect(records.map((entry) => entry.legacyHookName).sort()).toEqual(
      [...NORMALIZED_LEGACY_HOOKS].sort()
    )
    expect(records.every((entry) => entry.source === "legacy-hooks")).toBe(true)
  })

  it("produces nothing for a bag with no interceptor-shaped hooks", () => {
    expect(interceptorsFromLegacyHooks("p1", { onEnable: () => {} } as PluginHooksAll)).toEqual([])
  })

  it("derives ids from plugin + hook so a reload replaces rather than stacks", () => {
    const first = interceptorsFromLegacyHooks("p1", {
      onChatRequest: () => undefined,
    } as unknown as PluginHooksAll)
    const second = interceptorsFromLegacyHooks("p1", {
      onChatRequest: () => undefined,
    } as unknown as PluginHooksAll)
    expect(first[0]!.registrationId).toBe(second[0]!.registrationId)
  })

  it("threads onChatRequest as a real pipeline, not last-writer-wins", async () => {
    const makeHook = (suffix: string): PluginHooksAll =>
      ({
        onChatRequest: (messages: Array<{ content: string }>) =>
          messages.map((message) => ({ ...message, content: `${message.content}${suffix}` })),
      }) as unknown as PluginHooksAll

    const chain = [
      ...interceptorsFromLegacyHooks("a", makeHook("-a")),
      ...interceptorsFromLegacyHooks("b", makeHook("-b")),
    ]

    const { value } = await dispatchTransform(
      legacyHookPointId("onChatRequest"),
      { messages: [{ content: "base" }], model: "m", sessionId: "s1" },
      { operationId: "op", chain: chainOf(chain, "model.request.prepare") }
    )

    // Both plugins ran, in order. The old dispatcher would have shown "base-b".
    expect((value as { messages: Array<{ content: string }> }).messages[0]!.content).toBe(
      "base-a-b"
    )
  })

  it("keeps onBuildOptions' shallow merge, and never nulls a host field", async () => {
    const chain = interceptorsFromLegacyHooks("a", {
      onBuildOptions: () => ({ model: "override", systemPrompt: undefined }),
    } as unknown as PluginHooksAll)

    const { value } = await dispatchTransform(
      legacyHookPointId("onBuildOptions"),
      { sessionId: "s1", model: "host", systemPrompt: "host prompt" },
      { operationId: "op", chain }
    )

    const patched = value as { model: string; systemPrompt?: string }
    expect(patched.model).toBe("override")
    // An omitted-or-undefined field means "leave it alone", not "clear it".
    expect(patched.systemPrompt).toBe("host prompt")
  })

  it("shows a later onPostToolUse plugin the EARLIER plugin's redaction", async () => {
    const redact = interceptorsFromLegacyHooks("a", {
      onPostToolUse: () => ({ modifiedResult: "[redacted]" }),
    } as unknown as PluginHooksAll)
    const inspected: unknown[] = []
    const observer = interceptorsFromLegacyHooks("b", {
      onPostToolUse: (_name: string, _args: unknown, result: unknown) => {
        inspected.push(result)
        return {}
      },
    } as unknown as PluginHooksAll)

    await dispatchTransform(
      legacyHookPointId("onPostToolUse"),
      {
        toolName: "read",
        toolArgs: {},
        toolResult: "SECRET",
        sessionId: "s1",
        projection: {},
      },
      { operationId: "op", chain: [...redact, ...observer] }
    )

    // The second plugin must not be able to hand the model back the raw value
    // simply by returning the original it was given.
    expect(inspected).toEqual(["[redacted]"])
  })

  it("accumulates additionalMessages across plugins", async () => {
    const chain = [
      ...interceptorsFromLegacyHooks("a", {
        onPostToolUse: () => ({ additionalMessages: [{ role: "system", content: "a" }] }),
      } as unknown as PluginHooksAll),
      ...interceptorsFromLegacyHooks("b", {
        onPostToolUse: () => ({ additionalMessages: [{ role: "system", content: "b" }] }),
      } as unknown as PluginHooksAll),
    ]

    const { value } = await dispatchTransform(
      legacyHookPointId("onPostToolUse"),
      { toolName: "t", toolArgs: {}, toolResult: null, sessionId: "s1", projection: {} },
      { operationId: "op", chain }
    )

    expect(
      (value as { projection: { additionalMessages?: unknown[] } }).projection.additionalMessages
    ).toHaveLength(2)
  })

  it("ignores a hook that returns a non-array where messages were expected", async () => {
    const chain = interceptorsFromLegacyHooks("a", {
      onChatRequest: () => "not an array",
    } as unknown as PluginHooksAll)

    const { value } = await dispatchTransform(
      legacyHookPointId("onChatRequest"),
      { messages: [{ content: "base" }], model: "m", sessionId: "s1" },
      { operationId: "op", chain }
    )

    expect((value as { messages: unknown[] }).messages).toEqual([{ content: "base" }])
  })
})
