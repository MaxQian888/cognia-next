import JSZip from "jszip"
import { generateKeyPairSync, sign } from "node:crypto"

import { sha256Hex } from "@/lib/share/hash"
import { createTemplateDefinition } from "./contracts"
import {
  TEMPLATE_PACKAGE_SCHEMA_VERSION,
  exportTemplatePackage,
  inspectTemplatePackage,
  templatePackageSignaturePayload,
} from "./package"

async function definition(id = "skill.summary") {
  return createTemplateDefinition({
    id,
    domain: "skill",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Summary" },
    payload: { content: "Summarize {{topic}}" },
    inputs: [{ id: "topic", kind: "string", label: "Topic", required: true }],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user" },
  })
}

describe("template package boundary", () => {
  it("exports and inspects an inert, checksum-verified package", async () => {
    const packaged = await exportTemplatePackage({
      id: "com.example.summary",
      version: "1.0.0",
      name: "Summary package",
      entrypoints: ["skill.summary"],
      definitions: [await definition()],
      assets: [{ path: "icons/summary.svg", bytes: new TextEncoder().encode("<svg />") }],
    })

    const inspected = await inspectTemplatePackage(packaged.bytes)
    expect(inspected.manifest.schemaVersion).toBe(TEMPLATE_PACKAGE_SCHEMA_VERSION)
    expect(inspected.manifest.entrypoints).toEqual(["skill.summary@1.0.0"])
    expect(inspected.definitions).toHaveLength(1)
    expect(inspected.definitions[0].payload).toEqual({ content: "Summarize {{topic}}" })
    expect(inspected.assets.get("icons/summary.svg")).toEqual(new TextEncoder().encode("<svg />"))
    expect(packaged.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("rejects a dependency cycle before export", async () => {
    const first = await definition("skill.first")
    const second = await definition("skill.second")
    first.dependencies = [
      {
        id: "skill.second",
        kind: "template",
        requirement: "required",
        version: "1.0.0",
      },
    ]
    second.dependencies = [
      {
        id: "skill.first",
        kind: "template",
        requirement: "required",
        version: "1.0.0",
      },
    ]

    await expect(
      exportTemplatePackage({
        id: "com.example.cycle",
        version: "1.0.0",
        name: "Cycle",
        entrypoints: ["skill.first"],
        definitions: [first, second],
      })
    ).rejects.toThrow(/cycle/i)
  })

  it("rejects future schemas and tampered definition checksums", async () => {
    const def = await definition()
    const body = JSON.stringify(def)
    const zip = new JSZip()
    zip.file(
      "manifest.json",
      JSON.stringify({
        schemaVersion: TEMPLATE_PACKAGE_SCHEMA_VERSION + 1,
        apiVersion: "cognia.ai/templates/v1",
        id: "com.example.future",
        version: "1.0.0",
        name: "Future",
        entrypoints: ["skill.summary@1.0.0"],
        definitions: [
          {
            id: "skill.summary",
            version: "1.0.0",
            path: "definitions/skill.summary@1.0.0.json",
            sha256: await sha256Hex(body),
          },
        ],
        assets: [],
      })
    )
    zip.file("definitions/skill.summary@1.0.0.json", body)
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(inspectTemplatePackage(bytes)).rejects.toThrow(/future|unsupported/i)

    const good = await exportTemplatePackage({
      id: "com.example.summary",
      version: "1.0.0",
      name: "Summary",
      entrypoints: ["skill.summary"],
      definitions: [def],
    })
    const tampered = await JSZip.loadAsync(good.bytes)
    tampered.file("definitions/skill.summary@1.0.0.json", JSON.stringify({ ...def, payload: {} }))
    await expect(
      inspectTemplatePackage(await tampered.generateAsync({ type: "uint8array" }))
    ).rejects.toThrow(/checksum/i)
  })

  it("rejects absolute and traversal archive paths", async () => {
    const def = await definition()
    const zip = new JSZip()
    zip.file("/definitions/escape.json", JSON.stringify(def))
    zip.file(
      "manifest.json",
      JSON.stringify({
        schemaVersion: TEMPLATE_PACKAGE_SCHEMA_VERSION,
        apiVersion: "cognia.ai/templates/v1",
        id: "com.example.escape",
        version: "1.0.0",
        name: "Escape",
        entrypoints: [],
        definitions: [],
        assets: [],
      })
    )

    await expect(
      inspectTemplatePackage(await zip.generateAsync({ type: "uint8array" }))
    ).rejects.toThrow(/path/i)
  })

  it("rejects forged signed provenance instead of trusting signature presence", async () => {
    const packaged = await exportTemplatePackage({
      id: "com.example.signed",
      version: "1.0.0",
      name: "Signed",
      entrypoints: ["skill.summary"],
      definitions: [await definition()],
    })
    const zip = await JSZip.loadAsync(packaged.bytes)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    manifest.signature = {
      algorithm: "ed25519",
      publisher: "example",
      publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
      signature: sign(null, templatePackageSignaturePayload(manifest), privateKey).toString(
        "base64"
      ),
    }
    zip.file("manifest.json", JSON.stringify(manifest))
    const signed = await zip.generateAsync({ type: "uint8array" })
    await expect(inspectTemplatePackage(signed)).resolves.toMatchObject({
      trust: "signed-unknown",
    })

    manifest.signature.signature = Buffer.alloc(64, 1).toString("base64")
    zip.file("manifest.json", JSON.stringify(manifest))
    await expect(
      inspectTemplatePackage(await zip.generateAsync({ type: "uint8array" }))
    ).rejects.toThrow(/signature verification/i)
  })
})
