/**
 * @jest-environment jsdom
 *
 * jsdom (not the default `node` project for `lib/**`) because these run against
 * the REAL pane-manager rather than a stub of it — the binding rule this module
 * encodes is only worth anything if it agrees with the thing that does the
 * binding — and the manager publishes a marker on `document.documentElement`.
 */
let mockIsTauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    embedCreate: jest.fn().mockResolvedValue("codeserver-embed"),
    embedSetBounds: jest.fn().mockResolvedValue(undefined),
    embedSetVisible: jest.fn().mockResolvedValue(undefined),
    embedNavigate: jest.fn().mockResolvedValue(undefined),
    embedSetBackground: jest.fn().mockResolvedValue(undefined),
    embedDestroy: jest.fn().mockResolvedValue(undefined),
  },
}))

import type { ElementRect } from "@/lib/browser/protocol"
import {
  __resetCodeServerPaneManagerForTesting,
  claimCodeServerPane,
  destroyCodeServerPane,
  releaseCodeServerPane,
} from "./pane-manager"
import { ProIdeRootUnresolvedError, resolveProIdeRoot } from "./resolve-root"

const RECT: ElementRect = { x: 10, y: 20, width: 300, height: 400 }
const ROOT_A = "/Users/dev/project-a"
const ROOT_B = "/Users/dev/project-b"

const claim = (ownerId: string, root: string) =>
  claimCodeServerPane({
    ownerId,
    root,
    url: "http://127.0.0.1:43117/",
    rect: RECT,
    onRevoked: jest.fn(),
  })

beforeEach(() => {
  mockIsTauri = true
  __resetCodeServerPaneManagerForTesting()
})

describe("explicit root wins", () => {
  it("returns the explicit root even when a different one is bound", async () => {
    await claim("editor", ROOT_A)
    expect(resolveProIdeRoot("action.editor.open", ROOT_B)).toBe(ROOT_B)
  })

  it("returns the explicit root with no pane ever claimed", () => {
    expect(resolveProIdeRoot("action.editor.open", ROOT_B)).toBe(ROOT_B)
  })

  it("trims surrounding whitespace", () => {
    expect(resolveProIdeRoot("action.editor.open", `  ${ROOT_B}\n`)).toBe(ROOT_B)
  })
})

describe("blank explicit values count as absent", () => {
  // These arrive from optional form fields and template interpolations that
  // resolved to nothing; treating them as roots would canonicalize "" backend-side.
  it.each([undefined, null, "", "   ", "\t\n"])("falls back for %p", async (value) => {
    await claim("editor", ROOT_A)
    expect(resolveProIdeRoot("action.editor.open", value)).toBe(ROOT_A)
  })

  it.each(["", "   "])("throws for %p when nothing is bound", (value) => {
    expect(() => resolveProIdeRoot("action.editor.open", value)).toThrow(ProIdeRootUnresolvedError)
  })
})

describe("the bound Pro IDE", () => {
  it("resolves to the claimed root", async () => {
    await claim("editor", ROOT_A)
    expect(resolveProIdeRoot("action.editor.open")).toBe(ROOT_A)
  })

  it("follows the latest claim when a surface takes the pane over", async () => {
    await claim("editor", ROOT_A)
    await claim("dock", ROOT_B)
    expect(resolveProIdeRoot("action.editor.open")).toBe(ROOT_B)
  })

  it("survives release — the parked instance is still serving that root", async () => {
    // The whole reason a headless caller can address the IDE at all: the user
    // navigating away from the editor tab must not un-address it.
    await claim("editor", ROOT_A)
    releaseCodeServerPane("editor")
    expect(resolveProIdeRoot("action.editor.open")).toBe(ROOT_A)
  })

  it("is cleared by destroy — that is the path that ends the instance", async () => {
    await claim("editor", ROOT_A)
    await destroyCodeServerPane()
    expect(() => resolveProIdeRoot("action.editor.open")).toThrow(ProIdeRootUnresolvedError)
  })

  it("binds even when the native embed failed, because the server is still up", async () => {
    // `ensure` succeeded before the claim, so code-server is serving this root
    // and the agent channel can drive it; only the *view* failed to paint.
    const { codeServerClient } = jest.requireMock("@/lib/codeserver/client")
    codeServerClient.embedCreate.mockRejectedValueOnce(new Error("main window not found"))
    await expect(claim("editor", ROOT_A)).rejects.toThrow("main window not found")
    expect(resolveProIdeRoot("action.editor.open")).toBe(ROOT_A)
  })

  it("binds outside Tauri too, where the claim short-circuits", async () => {
    mockIsTauri = false
    await claim("editor", ROOT_A)
    expect(resolveProIdeRoot("action.editor.open")).toBe(ROOT_A)
  })
})

describe("the unresolved error", () => {
  it("names the caller so the user sees which step failed", () => {
    expect(() => resolveProIdeRoot("action.editor.showDiff")).toThrow(
      /^action\.editor\.showDiff: no Pro IDE is bound/
    )
  })

  it("tells the user both ways out", () => {
    try {
      resolveProIdeRoot("read_active_editor")
      throw new Error("expected a throw")
    } catch (cause) {
      expect((cause as Error).message).toContain('pass an explicit "root"')
      expect((cause as Error).message).toContain("open the Pro IDE editor once")
    }
  })

  it("is identifiable by name after serialization across the tool boundary", () => {
    // Agent tools stringify failures; the name is what survives to tell
    // "never opened the IDE" apart from "the IDE rejected this".
    const error = new ProIdeRootUnresolvedError("action.editor.open")
    expect(error.name).toBe("ProIdeRootUnresolvedError")
    expect(error).toBeInstanceOf(Error)
  })
})
