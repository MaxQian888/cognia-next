import { sha256Bytes } from "@/lib/ocr/hash"
import { loadJSZip } from "@/lib/packaging/signed-zip"
import { encodeBase64 } from "@/lib/share/encoding"

import { exportCogpack, type CogpackSigner, type ExportCogpackInput } from "./package"
import {
  __resetAnsweredTransfersForTests,
  installTransferredCogpack,
  type TransferInstallDeps,
} from "./transfer-install"

const text = (value: string) => new TextEncoder().encode(value)
const UPLOAD = "11111111-1111-4111-8111-111111111111"
const OP = "22222222-2222-4222-8222-222222222222"

function input(overrides: Partial<ExportCogpackInput> = {}): ExportCogpackInput {
  return {
    id: "transfer.work-laptop",
    version: "1.0.0",
    name: "Plugins from Work laptop",
    minHostVersion: "0.1.0",
    members: [
      {
        id: "acme-notes",
        name: "Notes",
        version: "0.2.0",
        optional: false,
        source: { kind: "embedded" },
      },
    ],
    embedded: new Map([
      [
        "acme-notes",
        [
          { path: "plugin.json", bytes: text('{"id":"acme-notes","version":"0.2.0"}') },
          { path: "index.js", bytes: text("export {}") },
        ],
      ],
    ]),
    ...overrides,
  }
}

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

function deps(overrides: Partial<TransferInstallDeps> = {}): TransferInstallDeps & {
  installStaged: jest.Mock
  recordOrigin: jest.Mock
  activate: jest.Mock
} {
  return {
    resolveTrust: jest.fn(async () => ({ trust: "signed-unknown" as const })),
    installStaged: jest.fn(async () => ({
      fingerprint: "f".repeat(64),
      installed: [{ pluginId: "acme-notes", version: "0.2.0" }],
      failed: [],
    })),
    recordOrigin: jest.fn(async () => undefined),
    activate: jest.fn(async () => []),
    ...overrides,
  } as never
}

beforeEach(() => __resetAnsweredTransfersForTests())

describe("installTransferredCogpack", () => {
  it("installs the verified members, anchored on the manifest the archive carries", async () => {
    const exported = await exportCogpack({ ...input(), signer: await signer() })
    const d = deps()
    const result = await installTransferredCogpack(
      { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest, adminLease: "lease" },
      d
    )
    expect(result.installed).toEqual([{ pluginId: "acme-notes", version: "0.2.0" }])

    // The hash Rust checks is the hash of the archive's own manifest.json.
    const zip = await (await loadJSZip()).loadAsync(exported.bytes)
    const archived = await zip.file("manifest.json")!.async("uint8array")
    expect(d.installStaged).toHaveBeenCalledWith({
      uploadId: UPLOAD,
      manifestSha256: await sha256Bytes(archived),
      members: [{ id: "acme-notes", version: "0.2.0" }],
    })
    expect(d.recordOrigin).toHaveBeenCalledWith(
      { pluginId: "acme-notes", version: "0.2.0" },
      { cogpackId: "transfer.work-laptop", version: "1.0.0", fingerprint: "f".repeat(64) }
    )
    expect(d.activate).toHaveBeenCalledWith(["acme-notes"])
  })

  it("refuses what this host's own plugin policy refuses, and never trusts the signer for it", async () => {
    const exported = await exportCogpack(input())
    const d = deps({
      resolveTrust: jest.fn(async () => ({
        trust: "unsigned" as const,
        refusedBy: "signature-required" as const,
      })),
    })
    await expect(
      installTransferredCogpack(
        { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
        d
      )
    ).rejects.toThrow(/^cogpack_refused: signature-required/)
    expect(d.installStaged).not.toHaveBeenCalled()
  })

  it("refuses a manifest whose signature does not verify", async () => {
    const exported = await exportCogpack({ ...input(), signer: await signer() })
    const forged = { ...exported.manifest, name: "Something else" }
    await expect(
      installTransferredCogpack({ uploadId: UPLOAD, operationId: OP, manifest: forged }, deps())
    ).rejects.toThrow(/^cogpack_signature_invalid/)
  })

  it("refuses a member this host would have to fetch from elsewhere", async () => {
    const exported = await exportCogpack(
      input({
        members: [
          ...input().members,
          {
            id: "gh-tools",
            name: "GitHub tools",
            version: "1.0.0",
            optional: false,
            source: {
              kind: "github",
              owner: "acme",
              repo: "tools",
              commit: "0123456789abcdef0123456789abcdef01234567",
            },
          },
        ],
      })
    )
    await expect(
      installTransferredCogpack(
        { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
        deps()
      )
    ).rejects.toThrow(/^cogpack_member_not_embedded: gh-tools/)
  })

  it("reports a plugin that installed but could not be enabled as not installed", async () => {
    const exported = await exportCogpack(input())
    const d = deps({
      activate: jest.fn(async () => [
        { pluginId: "acme-notes", message: "plugin_not_discovered: refused" },
      ]),
    })
    const result = await installTransferredCogpack(
      { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest },
      d
    )
    expect(result.installed).toEqual([])
    expect(result.failed).toEqual([
      { pluginId: "acme-notes", message: "plugin_not_discovered: refused" },
    ])
  })

  it("answers a retried operation with what the first call installed", async () => {
    const exported = await exportCogpack(input())
    const d = deps()
    const request = { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest }
    const first = await installTransferredCogpack(request, d)
    await expect(installTransferredCogpack(request, d)).resolves.toEqual(first)
    expect(d.installStaged).toHaveBeenCalledTimes(1)
  })

  it("rejects fields it does not know", async () => {
    const exported = await exportCogpack(input())
    await expect(
      installTransferredCogpack(
        { uploadId: UPLOAD, operationId: OP, manifest: exported.manifest, trustSigner: true },
        deps()
      )
    ).rejects.toThrow(/trustSigner/)
  })
})
