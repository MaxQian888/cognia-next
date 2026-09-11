/** @jest-environment node */
import { VIEW_COMMANDS } from "./view-commands"

describe("/view structured content", () => {
  const run = (part: Record<string, unknown>) =>
    VIEW_COMMANDS[0].handler?.({
      args: "p1",
      version: "0",
      config: {},
      state: { cells: [{ id: "c", kind: "content-part", partId: "p1", part }] },
    } as never)

  it("opens a validated A2UI keyboard overlay", () => {
    expect(
      run({
        type: "a2ui",
        surfaceId: "s",
        source: "external",
        payload: {
          rootId: "root",
          components: { root: { id: "root", component: "Text", text: "Hello" } },
        },
      })
    ).toMatchObject({ kind: "openOverlay", overlay: { kind: "a2ui" } })
  })

  it("opens other structured parts as a redacted document fallback", () => {
    expect(
      run({ type: "custom", customType: "plugin.card", summary: "Hello\u001b[2Jworld" })
    ).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "document", body: expect.not.stringContaining("\u001b") },
    })
  })
})

it("opens a localized path form for bare /view", () => {
  expect(
    VIEW_COMMANDS[0].handler?.({
      args: "",
      config: { locale: "zh-CN" },
      state: { cells: [] },
    } as never)
  ).toMatchObject({
    kind: "openForm",
    form: { commandName: "view", specs: [{ name: "path", label: "文件路径" }] },
  })
})

it("reports invalid structured content and preserves the file runtime route", () => {
  const run = (args: string, part?: unknown) =>
    VIEW_COMMANDS[0].handler?.({
      args,
      config: { locale: "zh-CN" },
      state: { cells: part ? [{ id: "c", kind: "content-part", partId: "p", part }] : [] },
    } as never)
  expect(run("file.txt")).toMatchObject({ kind: "runtime" })
  expect(run("p", { type: "a2ui", surfaceId: "bad", payload: {} })).toMatchObject({
    message: expect.stringContaining("无法打开"),
  })
  const circular: Record<string, unknown> = { type: "custom" }
  circular.self = circular
  expect(run("p", circular)).toMatchObject({ overlay: { body: "结构化内容不可用。" } })
})
