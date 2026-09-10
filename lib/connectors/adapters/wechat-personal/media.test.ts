const mockReadBinaryFile = jest.fn()
const mockStatFile = jest.fn()
jest.mock("@/lib/file/file-operations", () => ({
  readBinaryFile: (...args: unknown[]) => mockReadBinaryFile(...args),
  statFile: (...args: unknown[]) => mockStatFile(...args),
}))
const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))
const mockProxyFetch = jest.fn()
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => mockProxyFetch(...args),
}))
import { createCipheriv } from "node:crypto"
import type { AdapterContext } from "@/types/connectors/adapter"
import { encryptIlinkMedia, uploadIlinkMedia } from "./media"
const mockAttachmentRead = jest.fn(async (..._a: unknown[]): Promise<string | null> => null)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsAttachmentRead: (...a: unknown[]) => mockAttachmentRead(...a),
}))

import {
  aes128DecryptBlock,
  decryptIlinkMedia,
  base64ToBytes,
  bytesToBase64,
  fetchAndDecryptIlinkMediaViaTauri,
  ILINK_MEDIA_MAX_BYTES,
} from "./media"

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
}

// FIPS-197 Appendix C.1 known-answer vector.
const KEY = hexToBytes("000102030405060708090a0b0c0d0e0f")
const CT = hexToBytes("69c4e0d86a7b0430d8cdb78070b4c55a")
const PT = "00112233445566778899aabbccddeeff"
function paddedCiphertext(plaintext: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", KEY, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

describe("aes128DecryptBlock (FIPS-197 C.1)", () => {
  it("decrypts the standard known-answer block", () => {
    expect(bytesToHex(aes128DecryptBlock(CT, KEY))).toBe(PT)
  })

  it("rejects non-16-byte block/key", () => {
    expect(() => aes128DecryptBlock(new Uint8Array(15), KEY)).toThrow()
  })
})

describe("decryptIlinkMedia (ECB + PKCS7)", () => {
  it("decrypts multi-block ECB ciphertext with a raw-bytes base64 key", () => {
    const ct = paddedCiphertext(hexToBytes(PT + PT))
    const out = decryptIlinkMedia(ct, bytesToBase64(KEY))
    expect(bytesToHex(out)).toBe(PT + PT)
  })

  it("accepts a hex-string-form key (32 ASCII chars base64-encoded)", () => {
    const hexKeyAscii = "000102030405060708090a0b0c0d0e0f" // 32 chars
    const keyB64 = bytesToBase64(new TextEncoder().encode(hexKeyAscii))
    expect(bytesToHex(decryptIlinkMedia(paddedCiphertext(hexToBytes(PT)), keyB64))).toBe(PT)
  })

  it("throws on non-block-aligned ciphertext", () => {
    expect(() => decryptIlinkMedia(new Uint8Array(20), bytesToBase64(KEY))).toThrow(
      /multiple of 16/
    )
  })
})

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const b = new Uint8Array([0, 255, 16, 200])
    expect(Array.from(base64ToBytes(bytesToBase64(b)))).toEqual([0, 255, 16, 200])
  })
})

describe("fetchAndDecryptIlinkMediaViaTauri", () => {
  beforeEach(() => {
    mockAttachmentRead.mockReset()
    mockAttachmentRead.mockResolvedValue(null)
  })

  it("downloads via fetchAttachment then returns the cached bytes when no key is given", async () => {
    const fetchAttachment = jest.fn(async () => ({ localUrl: "file:///c", remoteRef: "r" }))
    mockAttachmentRead.mockResolvedValue(bytesToBase64(new Uint8Array([1, 2, 3])))
    const out = await fetchAndDecryptIlinkMediaViaTauri({
      adapterId: "wx1",
      url: "https://cdn/x",
      fetchAttachment,
    })
    expect(Array.from(out)).toEqual([1, 2, 3])
    expect(fetchAttachment).toHaveBeenCalledWith("wx1", "https://cdn/x")
    expect(mockAttachmentRead).toHaveBeenCalledWith("wx1", "https://cdn/x", ILINK_MEDIA_MAX_BYTES)
  })

  it("decrypts the cached bytes with the AES key", async () => {
    mockAttachmentRead.mockResolvedValue(bytesToBase64(paddedCiphertext(hexToBytes(PT))))
    const out = await fetchAndDecryptIlinkMediaViaTauri({
      adapterId: "wx1",
      url: "https://cdn/x",
      aesKeyBase64: bytesToBase64(KEY),
      fetchAttachment: jest.fn(async () => ({})),
    })
    expect(bytesToHex(out)).toBe(PT)
  })

  it("throws when the attachment cache read returns null", async () => {
    await expect(
      fetchAndDecryptIlinkMediaViaTauri({
        adapterId: "wx1",
        url: "https://cdn/x",
        fetchAttachment: jest.fn(async () => ({})),
      })
    ).rejects.toThrow(/attachment cache/)
  })

  it("propagates fetchAttachment (download) failures", async () => {
    await expect(
      fetchAndDecryptIlinkMediaViaTauri({
        adapterId: "wx1",
        url: "https://cdn/x",
        fetchAttachment: jest.fn(async () => {
          throw new Error("download refused")
        }),
      })
    ).rejects.toThrow(/download refused/)
    expect(mockAttachmentRead).not.toHaveBeenCalled()
  })

  it("honours the readAttachment test seam", async () => {
    const readAttachment = jest.fn(async () => bytesToBase64(new Uint8Array([9])))
    const out = await fetchAndDecryptIlinkMediaViaTauri({
      adapterId: "wx1",
      url: "https://cdn/x",
      fetchAttachment: jest.fn(async () => ({})),
      readAttachment,
    })
    expect(Array.from(out)).toEqual([9])
    expect(mockAttachmentRead).not.toHaveBeenCalled()
  })
})

describe("outbound media encryption and CDN handshake", () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(true)
    mockReadBinaryFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
    mockStatFile.mockReset().mockResolvedValue({ isFile: true, size: 3 })
    mockProxyFetch.mockReset()
    mockProxyFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ "x-encrypted-param": "download-token" }),
    })
  })
  it.each([0, 1, 15, 16, 17, 31, 32, 1024])(
    "matches Node AES-128-ECB PKCS7 for %i bytes",
    (length) => {
      const plain = Uint8Array.from({ length }, (_, i) => i % 256)
      const cipher = createCipheriv("aes-128-ecb", KEY, null)
      const expected = Buffer.concat([cipher.update(plain), cipher.final()])
      expect(bytesToHex(encryptIlinkMedia(plain, KEY))).toBe(expected.toString("hex"))
      expect(decryptIlinkMedia(encryptIlinkMedia(plain, KEY), bytesToBase64(KEY))).toEqual(plain)
    }
  )
  it.each([0, 17, 2])("rejects malformed PKCS7 padding ending in %i", (last) => {
    const padded = new Uint8Array(16).fill(7)
    padded[15] = last
    const cipher = createCipheriv("aes-128-ecb", KEY, null)
    cipher.setAutoPadding(false)
    const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()])
    expect(() => decryptIlinkMedia(ciphertext, bytesToBase64(KEY))).toThrow(/padding/)
  })
  it("rejects empty ciphertext", () => {
    expect(() => decryptIlinkMedia(new Uint8Array(), bytesToBase64(KEY))).toThrow(/padding/)
  })
  it.each([
    ["file:///tmp/report%20one.pdf", "/tmp/report one.pdf"],
    ["file:///C:/files/report.pdf", "C:/files/report.pdf"],
  ])("uploads local file URI %s", async (url, path) => {
    const args = input({
      type: "file",
      url,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    })
    await uploadIlinkMedia(args)
    expect(mockStatFile).toHaveBeenCalledWith(path)
    expect(mockReadBinaryFile).toHaveBeenCalledWith(path)
    expect(args.tauri.fetchAttachment).not.toHaveBeenCalled()
    expect(JSON.parse((args.tauri.httpRequest as jest.Mock).mock.calls[0][0].body).rawsize).toBe(3)
  })
  it.each([
    { isFile: false, size: 3 },
    { isFile: true, size: ILINK_MEDIA_MAX_BYTES + 1 },
    { isFile: true, size: 0 },
  ])("rejects invalid local metadata before reading %o", async (metadata) => {
    mockStatFile.mockResolvedValue(metadata)
    const args = input({ type: "image", url: "file:///tmp/image.png" })
    await expect(uploadIlinkMedia(args)).rejects.toThrow()
    expect(mockReadBinaryFile).not.toHaveBeenCalled()
    expect(args.tauri.httpRequest).not.toHaveBeenCalled()
  })
  it("rejects local sources outside desktop without filesystem or network calls", async () => {
    mockIsTauri.mockReturnValue(false)
    const args = input({ type: "image", url: "file:///tmp/image.png" })
    await expect(uploadIlinkMedia(args)).rejects.toThrow(/desktop runtime/)
    expect(mockStatFile).not.toHaveBeenCalled()
    expect(mockReadBinaryFile).not.toHaveBeenCalled()
    expect(args.tauri.httpRequest).not.toHaveBeenCalled()
  })
  it("propagates local read failures without uploading", async () => {
    mockReadBinaryFile.mockRejectedValue(new Error("permission denied"))
    const args = input({ type: "image", url: "file:///tmp/image.png" })
    await expect(uploadIlinkMedia(args)).rejects.toThrow(/permission denied/)
    expect(args.tauri.httpRequest).not.toHaveBeenCalled()
    expect(mockProxyFetch).not.toHaveBeenCalled()
  })
  it("rejects local files that grow beyond the cap while reading", async () => {
    mockReadBinaryFile.mockResolvedValue(new Uint8Array(ILINK_MEDIA_MAX_BYTES + 1))
    const args = input({ type: "image", url: "file:///tmp/image.png" })
    await expect(uploadIlinkMedia(args)).rejects.toThrow(/20 MiB/)
    expect(args.tauri.httpRequest).not.toHaveBeenCalled()
  })
  it("rejects invalid encryption keys", () => {
    expect(() => encryptIlinkMedia(new Uint8Array(1), new Uint8Array(15))).toThrow(/16-byte/)
  })
  function input(
    segment: Parameters<typeof uploadIlinkMedia>[0]["segment"],
    result = { upload_param: "signed token" }
  ) {
    const httpRequest = jest.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(result),
    }))
    return {
      adapterId: "wx1",
      baseUrl: "https://api.weixin.qq.com",
      token: "secret",
      userId: "user",
      segment,
      tauri: { httpRequest, fetchAttachment: jest.fn() } as unknown as AdapterContext["tauri"],
    }
  }
  it.each(["image", "video", "file", "voice"] as const)(
    "uploads %s with official type, ciphertext, and message metadata",
    async (type) => {
      const args = input(
        type === "file"
          ? {
              type,
              url: "data:application/pdf;base64,AQID",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 3,
            }
          : { type, url: "data:audio/mpeg;base64,AQID" }
      )
      const out = await uploadIlinkMedia(args)
      const request = (args.tauri.httpRequest as jest.Mock).mock.calls[0][0]
      const body = JSON.parse(request.body)
      expect(body).toMatchObject({
        media_type: type === "image" ? 1 : type === "video" ? 2 : 3,
        rawsize: 3,
        filesize: 16,
        rawfilemd5: "5289df737df57326fcdd22597afb1fac",
        no_need_thumb: true,
        to_user_id: "user",
      })
      expect(mockProxyFetch.mock.calls[0][0]).toContain("encrypted_query_param=signed%20token")
      const posted = mockProxyFetch.mock.calls[0][1]
      expect(posted.headers).toEqual({ "Content-Type": "application/octet-stream" })
      expect(decryptIlinkMedia(posted.body, btoa(body.aeskey))).toEqual(new Uint8Array([1, 2, 3]))
      expect(out.mediaItem.media).toEqual({
        encrypt_query_param: "download-token",
        aes_key: btoa(body.aeskey),
        encrypt_type: 1,
      })
      expect(out.itemType).toBe(type === "image" ? 2 : type === "video" ? 5 : 4)
      if (type === "file")
        expect(out.mediaItem).toMatchObject({ file_name: "report.pdf", len: "3" })
      if (type === "voice") expect(out.mediaItem.file_name).toBe("audio.mpeg")
    }
  )
  it("prefers full upload URLs and downloads external sources through attachment cache", async () => {
    mockAttachmentRead.mockResolvedValue("AQID")
    const args = input({ type: "image", url: "https://example.com/image.jpg" }, {
      upload_full_url: "https://cdn.weixin.qq.com/full",
      upload_param: "ignored",
    } as never)
    await uploadIlinkMedia(args)
    expect(args.tauri.fetchAttachment).toHaveBeenCalledWith("wx1", "https://example.com/image.jpg")
    expect(mockProxyFetch.mock.calls[0][0]).toBe("https://cdn.weixin.qq.com/full")
  })
  it("retries server failures and missing CDN headers, but never retries a 4xx", async () => {
    const args = input({ type: "image", url: "data:image/png;base64,AQID" })
    mockProxyFetch
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200, headers: new Headers() })
    await expect(uploadIlinkMedia(args)).resolves.toMatchObject({ itemType: 2 })
    expect(mockProxyFetch).toHaveBeenCalledTimes(3)
    mockProxyFetch.mockClear().mockResolvedValue({ status: 403 })
    await expect(uploadIlinkMedia(args)).rejects.toMatchObject({ retryable: false })
    expect(mockProxyFetch).toHaveBeenCalledTimes(1)
  })
  it("rejects session errors, missing upload parameters, and invalid sources before CDN dispatch", async () => {
    await expect(
      uploadIlinkMedia(
        input({ type: "image", url: "data:image/png;base64,AQID" }, { ret: -14 } as never)
      )
    ).rejects.toMatchObject({ sessionExpired: true })
    await expect(
      uploadIlinkMedia(input({ type: "image", url: "data:image/png;base64,AQID" }, {} as never))
    ).rejects.toThrow(/no HTTPS/)
    await expect(
      uploadIlinkMedia(input({ type: "image", url: "file://remote/tmp/x" }))
    ).rejects.toThrow(/file host/)
    await expect(
      uploadIlinkMedia(input({ type: "image", url: "unused", dataBase64: "=" }))
    ).rejects.toThrow(/base64/)
    expect(mockProxyFetch).not.toHaveBeenCalled()
  })
})
