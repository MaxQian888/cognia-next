import { sha256Bytes } from "@/lib/ocr/hash"
import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import { __resetManagementChannelsForTests } from "@/lib/remote-host/management-channel"
import type { CogpackSigner } from "@/lib/plugin/cogpack/package"
import { inspectCogpack } from "@/lib/plugin/cogpack/package"
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import type { Transport } from "@/lib/tauri/transport-types"

import {
  PluginChangedHereError,
  pluginsToTransfer,
  transferPlugins,
  type PluginTransferDeps,
} from "./plugin-transfer"
import type { MigrationPreflight } from "./types"

const OP = "33333333-3333-4333-8333-333333333333"
const text = (value: string) => new TextEncoder().encode(value)

async function signer(): Promise<CogpackSigner> {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  return {
    publisher: "Work laptop",
    publicKey: encodeBase64(raw),
    sign: async (payload) =>
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, Uint8Array.from(payload))
      ),
  }
}

/** A host that stages chunks the way the Rust upload service does. */
function host(chunkBytes = 64) {
  const staged: Uint8Array[] = []
  let declared = { byteLength: 0, sha256: "" }
  const call = jest.fn(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "plugin_cogpack_upload_open":
        declared = args as typeof declared
        return { uploadId: "upload-1", chunkBytes }
      case "plugin_cogpack_upload_write":
        expect(args.offset).toBe(staged.reduce((sum, chunk) => sum + chunk.byteLength, 0))
        staged.push(decodeBase64(args.dataBase64 as string))
        return { written: 0 }
      case "plugin_cogpack_upload_abort":
        return null
      case "plugin_cogpack_transfer_install":
        return {
          fingerprint: declared.sha256,
          installed: [{ pluginId: "acme-notes", version: "0.2.0" }],
          failed: [],
        }
      default:
        throw new Error(`unexpected ${command}`)
    }
  })
  const transport: Transport = { call: call as never, subscribe: jest.fn(() => () => undefined) }
  const bytes = () => {
    const out = new Uint8Array(staged.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of staged) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }
  return { call, transport, bytes, declared: () => declared }
}

function deps(
  transport: Transport,
  overrides: Partial<PluginTransferDeps> = {}
): PluginTransferDeps {
  return {
    channel: {
      openTarget: async () =>
        ({
          host: { id: "mini", label: "Mac mini", config: { deviceId: "d" } },
          transport,
          close: jest.fn(),
        }) as unknown as RemoteHostTarget,
    },
    readTree: async () => [
      { path: "plugin.json", bytes: text('{"id":"acme-notes","version":"0.2.0"}') },
      { path: "index.js", bytes: text("export const notes = 1\n".repeat(20)) },
    ],
    localPlugin: async () => ({ name: "Notes", version: "0.2.0" }),
    signer,
    newOperationId: () => OP,
    sourceLabel: () => "Work laptop",
    ...overrides,
  }
}

beforeEach(() => __resetManagementChannelsForTests())

describe("transferPlugins", () => {
  it("uploads one signed cogpack in checked chunks, then asks the host to install it", async () => {
    const h = host()
    const progress: string[] = []
    const result = await transferPlugins(
      "mini",
      [{ pluginId: "acme-notes", version: "0.2.0" }],
      { adminLease: "lease", onProgress: (p) => progress.push(p.phase) },
      deps(h.transport)
    )
    expect(result.installed).toEqual([{ pluginId: "acme-notes", version: "0.2.0" }])

    const uploaded = h.bytes()
    expect(h.declared()).toEqual({
      byteLength: uploaded.byteLength,
      sha256: await sha256Bytes(uploaded),
      adminLease: "lease",
    })
    const writes = h.call.mock.calls.filter(
      ([command]) => command === "plugin_cogpack_upload_write"
    )
    expect(writes.length).toBeGreaterThan(1)
    for (const [, args] of writes) {
      expect(args.chunkHash).toBe(await sha256Bytes(decodeBase64(args.dataBase64 as string)))
      expect(args.adminLease).toBe("lease")
    }

    const inspected = await inspectCogpack(uploaded)
    expect(inspected.signed).toBe(true)
    expect(inspected.manifest.members.map((m) => [m.id, m.version, m.source.kind])).toEqual([
      ["acme-notes", "0.2.0", "embedded"],
    ])
    const install = h.call.mock.calls.find(
      ([command]) => command === "plugin_cogpack_transfer_install"
    )
    expect(install?.[1]).toEqual({
      uploadId: "upload-1",
      operationId: OP,
      manifest: inspected.manifest,
      sourceLabel: "Work laptop",
      adminLease: "lease",
    })
    expect(progress[0]).toBe("packing")
    expect(progress.at(-1)).toBe("installing")
  })

  it("aborts the upload when a chunk fails, leaving nothing staged on the host", async () => {
    const h = host()
    const failing = jest.fn(async (command: string, args: Record<string, unknown>) => {
      if (command === "plugin_cogpack_upload_write") throw new Error("relay dropped")
      return h.call(command, args)
    })
    const transport: Transport = {
      call: failing as never,
      subscribe: jest.fn(() => () => undefined),
    }
    await expect(
      transferPlugins(
        "mini",
        [{ pluginId: "acme-notes", version: "0.2.0" }],
        { adminLease: "lease" },
        deps(transport)
      )
    ).rejects.toThrow("relay dropped")
    expect(failing).toHaveBeenCalledWith("plugin_cogpack_upload_abort", {
      uploadId: "upload-1",
      adminLease: "lease",
    })
  })

  it("refuses to send a plugin that changed here since preflight", async () => {
    const h = host()
    await expect(
      transferPlugins(
        "mini",
        [{ pluginId: "acme-notes", version: "0.2.0" }],
        { adminLease: "lease" },
        deps(h.transport, { localPlugin: async () => ({ name: "Notes", version: "0.3.0" }) })
      )
    ).rejects.toBeInstanceOf(PluginChangedHereError)
    expect(h.call).not.toHaveBeenCalled()
  })

  it("does nothing when nothing needs to travel", async () => {
    const h = host()
    await expect(
      transferPlugins("mini", [], { adminLease: "lease" }, deps(h.transport))
    ).resolves.toEqual({ fingerprint: "", installed: [], failed: [] })
    expect(h.call).not.toHaveBeenCalled()
  })
})

describe("pluginsToTransfer", () => {
  it("asks once per plugin for what transfer can clear, at the version installed here", () => {
    const preflight = (blockers: MigrationPreflight["blockers"]): MigrationPreflight => ({
      item: { kind: "bot-installation", id: "b" },
      label: "b",
      localStatus: "enabled",
      ready: false,
      blockers,
      notes: [],
      plugins: [],
      checkedAt: 1,
    })
    expect(
      pluginsToTransfer([
        preflight([
          { kind: "plugin-missing", pluginId: "zeta", version: "1.0.0" },
          { kind: "host-too-old" },
        ]),
        preflight([
          {
            kind: "plugin-version-mismatch",
            pluginId: "alpha",
            version: "2.0.0",
            hostVersion: "1.0.0",
          },
          { kind: "plugin-missing", pluginId: "zeta", version: "1.0.0" },
        ]),
      ])
    ).toEqual([
      { pluginId: "alpha", version: "2.0.0" },
      { pluginId: "zeta", version: "1.0.0" },
    ])
  })
})
