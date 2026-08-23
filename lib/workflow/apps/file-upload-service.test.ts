/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  WorkflowAppFileError,
  resolveDifyInputFiles,
  resolveWorkflowAppFile,
  uploadWorkflowAppFile,
} from "./file-upload-service"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

beforeEach(async () => {
  __resetDbForTesting()
  await whenSeeded()
  await getDb().sessionAttachmentUploads.clear()
})

describe("workflow app file uploads", () => {
  it("quarantines, sniffs, and returns the Dify 1.16 response contract", async () => {
    const uploaded = await uploadWorkflowAppFile({
      accountId: "acct_1",
      appId: "app_1",
      externalSubjectKey: "dify:customer-7",
      name: "photo.txt",
      declaredMediaType: "text/plain",
      bytes: PNG,
      now: 1_700_000_000_000,
    })

    expect(uploaded).toMatchObject({
      id: expect.stringMatching(/^upl_/),
      name: "photo.txt",
      size: PNG.byteLength,
      extension: "txt",
      mime_type: "image/png",
      created_by: expect.stringMatching(/^[0-9a-f-]{36}$/),
      created_at: 1_700_000_000,
    })
    const row = await getDb().sessionAttachmentUploads.get(uploaded.id)
    expect(row).toMatchObject({ status: "committed", mediaType: "image/png" })
  })

  it("binds an uploaded ID to both the application and Dify end user", async () => {
    const uploaded = await uploadWorkflowAppFile({
      accountId: "acct_1",
      appId: "app_1",
      externalSubjectKey: "dify:customer-7",
      name: "photo.png",
      declaredMediaType: "image/png",
      bytes: PNG,
    })

    await expect(
      resolveWorkflowAppFile({
        accountId: "acct_1",
        appId: "app_1",
        externalSubjectKey: "dify:customer-7",
        uploadFileId: uploaded.id,
      })
    ).resolves.toMatchObject({ id: uploaded.id, ref: `cognia-upload:${uploaded.id}` })
    await expect(
      resolveWorkflowAppFile({
        accountId: "acct_1",
        appId: "app_1",
        externalSubjectKey: "dify:other-user",
        uploadFileId: uploaded.id,
      })
    ).rejects.toMatchObject({ code: "file_not_found" })
    await expect(
      resolveWorkflowAppFile({
        accountId: "acct_1",
        appId: "app_2",
        externalSubjectKey: "dify:customer-7",
        uploadFileId: uploaded.id,
      })
    ).rejects.toMatchObject({ code: "file_not_found" })
  })

  it("resolves nested Dify local_file mappings into owner-bound durable refs", async () => {
    const uploaded = await uploadWorkflowAppFile({
      accountId: "acct_1",
      appId: "app_1",
      externalSubjectKey: "dify:customer-7",
      name: "photo.png",
      declaredMediaType: "image/png",
      bytes: PNG,
    })
    await expect(
      resolveDifyInputFiles({
        accountId: "acct_1",
        appId: "app_1",
        externalSubjectKey: "dify:customer-7",
        value: {
          attachment: {
            type: "image",
            transfer_method: "local_file",
            upload_file_id: uploaded.id,
          },
        },
      })
    ).resolves.toMatchObject({
      attachment: {
        id: uploaded.id,
        upload_file_id: uploaded.id,
        transfer_method: "local_file",
        type: "image",
        ref: `cognia-upload:${uploaded.id}`,
      },
    })
  })

  it("rejects mismatched, remote, audio, and cross-owner Dify file mappings", async () => {
    const uploaded = await uploadWorkflowAppFile({
      accountId: "acct_1",
      appId: "app_1",
      externalSubjectKey: "dify:customer-7",
      name: "photo.png",
      declaredMediaType: "image/png",
      bytes: PNG,
    })
    const base = {
      accountId: "acct_1",
      appId: "app_1",
      externalSubjectKey: "dify:customer-7",
    }
    await expect(
      resolveDifyInputFiles({
        ...base,
        value: {
          type: "document",
          transfer_method: "local_file",
          upload_file_id: uploaded.id,
        },
      })
    ).rejects.toMatchObject({ code: "invalid_file" })
    await expect(
      resolveDifyInputFiles({
        ...base,
        value: { type: "image", transfer_method: "remote_url", url: "https://example.com/a.png" },
      })
    ).rejects.toMatchObject({ code: "unsupported_file_type" })
    await expect(
      resolveDifyInputFiles({
        ...base,
        value: { type: "audio", transfer_method: "local_file", upload_file_id: uploaded.id },
      })
    ).rejects.toMatchObject({ code: "unsupported_file_type" })
    await expect(
      resolveDifyInputFiles({
        ...base,
        externalSubjectKey: "dify:other",
        value: { type: "image", transfer_method: "local_file", upload_file_id: uploaded.id },
      })
    ).rejects.toMatchObject({ code: "file_not_found" })
  })

  it("maps quarantine refusals to Dify-compatible upload errors", async () => {
    await expect(
      uploadWorkflowAppFile({
        accountId: "acct_1",
        appId: "app_1",
        externalSubjectKey: "dify:customer-7",
        name: "payload.txt",
        declaredMediaType: "text/plain",
        bytes: new TextEncoder().encode(
          "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
        ),
      })
    ).rejects.toMatchObject({ code: "malicious_file", status: 415 })
  })

  it("exposes bounded machine-readable service errors", () => {
    const error = new WorkflowAppFileError("file_too_large", 413, "too large")
    expect(error.code).toBe("file_too_large")
    expect(error.status).toBe(413)
  })
})
