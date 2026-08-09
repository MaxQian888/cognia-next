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
