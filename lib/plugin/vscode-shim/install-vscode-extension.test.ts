/**
 * Tests for the single `.vsix` -> installed-plugin path.
 *
 * The `hostile_*` cases are regression tests for a real privilege-escalation
 * chain: the dialog persisted the raw VS Code `package.json` as the cognia
 * manifest, so an extension could self-declare
 * `vscodeExtension.publisherKeyFingerprint`, which `manager.ts` forwarded to
 * `lsp-binary-policy` — where a plain string match against `trustedPublishers`
 * granted prompt-free `child_process.spawn`.
 *
 * Fixtures are synthesised in-memory with JSZip, matching `vsix-installer.test.ts`.
 */

import JSZip from "jszip"

jest.mock("@/lib/db/plugins", () => ({ upsertPlugin: jest.fn(async (draft) => draft) }))
jest.mock("@/lib/native/utils", () => ({ canUseTauriInvoke: jest.fn(() => false) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } },
}))

import { invoke } from "@tauri-apps/api/core"
import { upsertPlugin } from "@/lib/db/plugins"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { canonicalExtensionId, InvalidExtensionIdError } from "./extension-id"
import {
  commitVscodeExtension,
  installVscodeExtensionFromBytes,
  prepareVscodeExtension,
} from "./install-vscode-extension"

const upsertPluginMock = upsertPlugin as jest.Mock
const canUseTauriInvokeMock = canUseTauriInvoke as jest.Mock
const invokeMock = invoke as unknown as jest.Mock

async function buildVsix(
  pkgJson: Record<string, unknown>,
  files: Record<string, string> = { "out/extension.js": "module.exports = {}" }
): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("extension/package.json", JSON.stringify(pkgJson))
  for (const [path, content] of Object.entries(files)) {
    zip.file(`extension/${path}`, content)
  }
  return zip.generateAsync({ type: "uint8array" })
}

const BENIGN = {
  publisher: "cognia",
  name: "hello",
  version: "1.0.0",
  main: "./out/extension.js",
  engines: { vscode: ">=1.74.0" },
}

beforeEach(() => {
  jest.clearAllMocks()
  canUseTauriInvokeMock.mockReturnValue(false)
})

describe("prepareVscodeExtension", () => {
  it("produces the fields the loader requires, which the raw package.json lacks", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")

    // `loadVscodeDefinition` throws without both of these.
    expect(prepared.adapted.manifest.vscodeMain).toBe("./out/extension.js")
    expect(prepared.adapted.manifest.vscodeExtension?.identifier).toBe("cognia.hello")
    // Neither exists on a real VS Code manifest — proving adaptation happened.
    expect(prepared.vsix.pkgJson).not.toHaveProperty("vscodeMain")
    expect(prepared.vsix.pkgJson).not.toHaveProperty("vscodeExtension")
  })

  it("threads the install source into the manifest", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "openvsx")
    expect(prepared.adapted.manifest.vscodeExtension?.source).toBe("openvsx")
  })

  it("escapes dots in an id component so the id cannot traverse", async () => {
    // Dots are what made `.` / `..` reachable; escaping them means the only
    // dot in the id is the separator itself.
    const prepared = await prepareVscodeExtension(
      await buildVsix({ ...BENIGN, publisher: "a.b" }),
      "vsix-upload"
    )
    expect(prepared.adapted.manifest.id).toBe("a-b.hello")
  })

  it("rejects a non-string publisher that slips past the parser", async () => {
    // `installVsix` guards the string/empty cases; this pins the id rule's own
    // guard, which is what the Rust command relies on for headless installs.
    expect(() => canonicalExtensionId(undefined, "hello")).toThrow(InvalidExtensionIdError)
  })

  it("relies on installVsix to reject empty publisher/name before the id rule", async () => {
    // Documents the layering: the parser is the first gate for `""`, and the
    // id rule is the second. Both matter — the Rust `plugin_vscode_install_vsix`
    // command is reachable without the parser (headless / registry installs),
    // which is why `sanitize_plugin_id_strict` enforces the same rule there.
    await expect(
      prepareVscodeExtension(await buildVsix({ ...BENIGN, publisher: "" }), "vsix-upload")
    ).rejects.toThrow(/missing required `publisher`/)
  })
})

describe("commitVscodeExtension", () => {
  it("persists the adapted manifest, never the raw package.json", async () => {
    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    await commitVscodeExtension(prepared)

    const draft = upsertPluginMock.mock.calls[0]![0]
    expect(draft.manifest).toBe(prepared.adapted.manifest)
    expect(draft.manifest).not.toBe(prepared.vsix.pkgJson)
    expect(draft.manifest.vscodeExtension.identifier).toBe("cognia.hello")
    expect(draft.type).toBe("vscode-extension")
    expect(draft.enabled).toBe(false)
  })

  it("maps the manifest source onto the PluginRow source vocabulary", async () => {
    // `PluginSource` has no "openvsx" member — the two fields share a name but
    // not a domain.
    const fromRegistry = await prepareVscodeExtension(await buildVsix(BENIGN), "openvsx")
    await commitVscodeExtension(fromRegistry)
    expect(upsertPluginMock.mock.calls[0]![0].source).toBe("marketplace")

    upsertPluginMock.mockClear()
    const fromDisk = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    await commitVscodeExtension(fromDisk)
    expect(upsertPluginMock.mock.calls[0]![0].source).toBe("local")
  })

  it("uses the Rust install path and rejects an id the two sides disagree on", async () => {
    canUseTauriInvokeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      extensionId: "cognia.hello",
      installPath: "/data/cognia/vscode-extensions/cognia.hello",
      sha256Hex: "a".repeat(64),
      packageJson: {},
    })

    const prepared = await prepareVscodeExtension(await buildVsix(BENIGN), "vsix-upload")
    await commitVscodeExtension(prepared)
    expect(upsertPluginMock.mock.calls[0]![0].path).toBe(
      "/data/cognia/vscode-extensions/cognia.hello"
    )

    // A drift between the TS and Rust id rules must fail loudly, not persist a
    // row that points at someone else's directory.
    upsertPluginMock.mockClear()
    invokeMock.mockResolvedValue({
      extensionId: "someone.else",
      installPath: "/data/cognia/vscode-extensions/someone.else",
      sha256Hex: "a".repeat(64),
      packageJson: {},
    })
    await expect(commitVscodeExtension(prepared)).rejects.toThrow(/id mismatch/)
    expect(upsertPluginMock).not.toHaveBeenCalled()
  })
})

describe("hostile manifests", () => {
  const HOSTILE = {
    publisher: "evil",
    name: "x",
    version: "1.0.0",
    main: "./out/extension.js",
    // Everything below is the attacker trying to forge adapter output.
    vscodeMain: "./out/extension.js",
    vscodeExtension: {
      identifier: "microsoft.vscode",
      publisherKeyFingerprint: "placeholder:microsoft.vscode",
      source: "dev",
    },
    permissions: ["shell:execute", "filesystem:write"],
    lspServers: [{ id: "evil", command: "./bin/payload", languages: ["rust"] }],
  }

  it("cannot inject publisherKeyFingerprint", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })

    // The one field that bought prompt-free child_process.spawn.
    expect(prepared.adapted.manifest.vscodeExtension?.publisherKeyFingerprint).toBeUndefined()
    const draft = upsertPluginMock.mock.calls[0]![0]
    expect(draft.manifest.vscodeExtension.publisherKeyFingerprint).toBeUndefined()
  })

  it("cannot impersonate another extension's identifier", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })

    // Derived from publisher/name, not copied from the attacker's block.
    expect(prepared.adapted.manifest.id).toBe("evil.x")
    expect(prepared.adapted.manifest.vscodeExtension?.identifier).toBe("evil.x")
  })

  it("cannot self-declare permissions or LSP servers", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })
    const manifest = prepared.adapted.manifest

    // Permissions are inferred from the bundle, never read off the manifest.
    // This extension's bundle requires nothing, so nothing is granted.
    expect(manifest.permissions).not.toContain("shell:execute")
    expect(manifest.permissions).not.toContain("filesystem:write")
    expect(manifest.lspServers ?? []).toHaveLength(0)
  })

  it("cannot override the install source recorded by the caller", async () => {
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(HOSTILE),
      source: "vsix-upload",
    })
    // The manifest claimed "dev"; the caller said "vsix-upload".
    expect(prepared.adapted.manifest.vscodeExtension?.source).toBe("vsix-upload")
  })

  it("still infers permissions the bundle actually implies", async () => {
    // The inverse guard: rejecting self-declared permissions must not mean
    // under-reporting real ones.
    const { prepared } = await installVscodeExtensionFromBytes({
      bytes: await buildVsix(
        { ...BENIGN },
        { "out/extension.js": "const cp = require('child_process'); cp.spawn('sh')" }
      ),
      source: "vsix-upload",
    })
    expect(prepared.adapted.manifest.permissions).toContain("process:spawn")
  })
})
