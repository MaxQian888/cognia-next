/** @jest-environment node */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import { makeConfiguredCliPluginToolHandle } from "./configured-plugin-tool-handle"
import type {
  PluginToolExecHostDeps,
  PluginToolExecRequest,
  PluginToolExecResponse,
} from "@/lib/claude/plugin-tool-ipc"

type PluginToolExecutorForTest = (
  request: PluginToolExecRequest,
  deps?: PluginToolExecHostDeps
) => Promise<PluginToolExecResponse>
const mockEnsureCliDb = jest.fn(async () => undefined)
const mockResolveAttachmentDeps = jest.fn(async () => ({
  list: jest.fn(),
  getMetadata: jest.fn(),
  search: jest.fn(),
}))
jest.mock("../db/bootstrap", () => ({ ensureCliDb: () => mockEnsureCliDb() }))
jest.mock("@/lib/claude/attachment-builtin-tools", () => ({
  resolveAttachmentToolDeps: () => mockResolveAttachmentDeps(),
}))

describe("makeConfiguredCliPluginToolHandle", () => {
  it("gives working_set a CLI-home file store instead of the Dexie session row", async () => {
    // LC-03: without it the shared tool looked the CLI session up in Dexie,
    // where CLI sessions never exist, and every call failed.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cli-ws-handle-"))
    try {
      const execute: PluginToolExecutorForTest = async (request, deps) => ({
        type: "plugin_tool_response",
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        result: await deps?.workingSetStore?.read(request.sessionId),
      })
      const handle = makeConfiguredCliPluginToolHandle(
        { ...DEFAULT_RESOLVED_CONFIG, cwd: "/workspace", cliHome: home },
        execute
      )
      const response = await handle({
        type: "plugin_tool_exec",
        sessionId: "s_cli",
        toolUseId: "w1",
        name: "working_set",
        args: { action: "get" },
      })
      expect(response.result).toMatchObject({ revision: 0, entries: [] })
      expect(mockEnsureCliDb).not.toHaveBeenCalled()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it("bootstraps the CLI database lazily before resolving attachment storage", async () => {
    const execute: PluginToolExecutorForTest = async (request, deps) => ({
      type: "plugin_tool_response",
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      result: await deps?.resolveAttachmentToolDeps?.(),
    })
    const handle = makeConfiguredCliPluginToolHandle(
      { ...DEFAULT_RESOLVED_CONFIG, cwd: "/workspace" },
      execute
    )
    expect(mockEnsureCliDb).not.toHaveBeenCalled()
    await handle({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "a1",
      name: "attachment_list",
      args: {},
    })
    expect(mockEnsureCliDb).toHaveBeenCalledTimes(1)
    expect(mockResolveAttachmentDeps).toHaveBeenCalledTimes(1)
    expect(mockEnsureCliDb.mock.invocationCallOrder[0]).toBeLessThan(
      mockResolveAttachmentDeps.mock.invocationCallOrder[0]
    )
  })
  it("injects the resolved CLI search configuration into the shared executor", async () => {
    const execute = jest.fn<
      Promise<PluginToolExecResponse>,
      [PluginToolExecRequest, PluginToolExecHostDeps?]
    >(async (request, hostDeps) => ({
      type: "plugin_tool_response" as const,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      result: await hostDeps?.resolveWebToolDeps?.(),
    }))
    const handle = makeConfiguredCliPluginToolHandle(
      {
        ...DEFAULT_RESOLVED_CONFIG,
        cwd: "/tmp/cognia-cli-test",
        search: {
          defaultProvider: "brave",
          providers: {
            brave: { apiKey: "cli-key", enabled: true, priority: 1 },
          },
        },
      },
      execute
    )

    const response = await handle({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "w1",
      name: "web_search",
      args: { query: "Cognia" },
    })

    // Provider settings are no longer copied onto the tool deps — they ride
    // inside the executor's own settings snapshot — so the observable contract
    // is that the CLI config produced a bound executor.
    expect(response.result).toMatchObject({ enabled: true })
    expect((response.result as { searchExecutor?: unknown })?.searchExecutor).toEqual(
      expect.any(Function)
    )
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("carries no per-plugin host dependencies", async () => {
    // The CLI used to hand one named plugin its own model bridge here. Every
    // plugin now reaches the model through `ctx.ai` and the session's host
    // runtime, so shared host dependencies only serve core tools: working_set,
    // web and attachments.
    const execute = jest.fn<
      Promise<PluginToolExecResponse>,
      [PluginToolExecRequest, PluginToolExecHostDeps?]
    >(async (request) => ({
      type: "plugin_tool_response" as const,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      result: null,
    }))
    const handle = makeConfiguredCliPluginToolHandle(
      { ...DEFAULT_RESOLVED_CONFIG, cwd: "/tmp/cognia-cli-test" },
      execute
    )

    await handle({
      type: "plugin_tool_exec",
      sessionId: "s-deep",
      toolUseId: "w-deep",
      name: "deep_research",
      args: { query: "Cognia" },
    })

    expect(Object.keys(execute.mock.calls[0]?.[1] ?? {})).toEqual([
      "workingSetStore",
      "resolveWebToolDeps",
      "resolveAttachmentToolDeps",
    ])
  })
})

it("refuses unattended user input without invoking a hidden dialog or inventing an answer", async () => {
  const execute = jest.fn(async () => new Promise<PluginToolExecResponse>(() => {}))
  const handle = makeConfiguredCliPluginToolHandle(
    { ...DEFAULT_RESOLVED_CONFIG, cwd: "/workspace" },
    execute,
    false
  )
  const response = handle({
    type: "plugin_tool_exec",
    sessionId: "s-headless",
    toolUseId: "q-1",
    name: "ask_user",
    args: {
      question: "May I bypass the redaction?",
      options: [{ value: "yes", label: "Approve" }],
    },
  })
  expect(execute).not.toHaveBeenCalled()
  await expect(response).resolves.toMatchObject({
    type: "plugin_tool_response",
    sessionId: "s-headless",
    toolUseId: "q-1",
    error: expect.stringContaining("No answer or authorization was provided"),
  })
  expect(await response).not.toHaveProperty("result")
})

it("keeps interactive ask_user and unattended non-question tools on their existing executor", async () => {
  const execute = jest.fn(async (request: PluginToolExecRequest) => ({
    type: "plugin_tool_response" as const,
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
    result: "explicit real response",
  }))
  const cfg = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/workspace" }
  const request = {
    type: "plugin_tool_exec" as const,
    sessionId: "s",
    toolUseId: "q",
    name: "ask_user",
    args: { question: "Choose" },
  }
  expect((await makeConfiguredCliPluginToolHandle(cfg, execute)(request)).result).toBe(
    "explicit real response"
  )
  expect(
    (
      await makeConfiguredCliPluginToolHandle(
        cfg,
        execute,
        false
      )({ ...request, name: "web_search" })
    ).result
  ).toBe("explicit real response")
  expect(execute).toHaveBeenCalledTimes(2)
})
