import "fake-indexeddb/auto"
import JSZip from "jszip"

jest.mock("@/lib/db/seed", () => ({ seedBuiltIns: jest.fn().mockResolvedValue(undefined) }))

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  HumanInputFilePolicyError,
  getHumanInputFile,
  humanInputFileRef,
  promoteHumanInputFile,
  pruneExpiredHumanInputFiles,
  scanHumanInputFile,
} from "./workflow-human-input-files"

const KEY = new Uint8Array(32).fill(23)
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowHumanInputFiles.clear()
})
afterAll(dbFixture.dispose)

describe("Human Input durable file quarantine", () => {
  it("encrypts clean files before persistence and enforces account/request scope on read", async () => {
    const bytes = new TextEncoder().encode("approved evidence")
    const promoted = await promoteHumanInputFile(
      {
        accountId: "account_1",
        requestId: "hir_1",
        responderId: "device:dev-1",
        fieldId: "evidence",
        name: "evidence.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
        hash: "a".repeat(64),
        bytes,
        expiresAt: 50_000,
        now: 1_000,
      },
      { loadKey: async () => KEY }
    )

    expect(promoted.ref).toBe(humanInputFileRef(promoted.id))
    const raw = await getDb().workflowHumanInputFiles.get(promoted.id)
    expect(raw?.envelope.ciphertext).not.toEqual(bytes)
    expect(new TextDecoder().decode(raw?.envelope.ciphertext)).not.toContain("approved evidence")

    await expect(
      getHumanInputFile(
        promoted.ref,
        { accountId: "account_1", requestId: "hir_1", now: 2_000 },
        { loadKey: async () => KEY }
      )
    ).resolves.toEqual(expect.objectContaining({ name: "evidence.txt", bytes }))
    await expect(
      getHumanInputFile(
        promoted.ref,
        { accountId: "other", requestId: "hir_1", now: 2_000 },
        { loadKey: async () => KEY }
      )
    ).resolves.toBeNull()
  })

  it("rejects active PDF content and executable signatures", async () => {
    await expect(
      scanHumanInputFile(new TextEncoder().encode("%PDF-1.7\n1 0 obj <</JavaScript (alert(1))>>"), {
        name: "active.pdf",
        mediaType: "application/pdf",
      })
    ).rejects.toMatchObject<Partial<HumanInputFilePolicyError>>({ code: "active-content" })

    await expect(
      scanHumanInputFile(Uint8Array.from([0x4d, 0x5a, 0x90, 0]), {
        name: "renamed.png",
        mediaType: "image/png",
      })
    ).rejects.toMatchObject<Partial<HumanInputFilePolicyError>>({ code: "executable" })
  })

  it("rejects macro-bearing and expansion-bomb office archives", async () => {
    const macro = new JSZip()
    macro.file("word/document.xml", "<document />")
    macro.file("word/vbaProject.bin", new Uint8Array([1, 2, 3]))
    await expect(
      scanHumanInputFile(await macro.generateAsync({ type: "uint8array" }), {
        name: "macro.docm",
        mediaType: "application/vnd.ms-word.document.macroEnabled.12",
      })
    ).rejects.toMatchObject<Partial<HumanInputFilePolicyError>>({ code: "dangerous-archive" })

    const bomb = new JSZip()
    bomb.file("word/document.xml", "0".repeat(2_000_000))
    await expect(
      scanHumanInputFile(await bomb.generateAsync({ type: "uint8array", compression: "DEFLATE" }), {
        name: "bomb.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    ).rejects.toMatchObject<Partial<HumanInputFilePolicyError>>({ code: "archive-bomb" })
  })

  it("physically removes expired ciphertext", async () => {
    const bytes = new TextEncoder().encode("short lived")
    const promoted = await promoteHumanInputFile(
      {
        accountId: "account_1",
        requestId: "hir_1",
        responderId: "device:dev-1",
        fieldId: "evidence",
        name: "evidence.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
        hash: "b".repeat(64),
        bytes,
        expiresAt: 2_000,
        now: 1_000,
      },
      { loadKey: async () => KEY }
    )

    await expect(pruneExpiredHumanInputFiles(2_001)).resolves.toBe(1)
    await expect(getDb().workflowHumanInputFiles.get(promoted.id)).resolves.toBeUndefined()
  })
})
