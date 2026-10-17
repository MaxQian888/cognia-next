import { requestBestOfNCancel } from "./paired"
import type { BestOfNGroup } from "@/types/best-of-n"

const group = (version: number) => ({ groupId: "g", version, ownerId: "desktop" }) as BestOfNGroup

it("asks the Host to stop with a fresh version and an owner id the Host cannot hold", async () => {
  const host = {
    get: jest.fn(async () => group(4)),
    cancel: jest.fn(async () => ({ ...group(5), phase: "cancelling" }) as BestOfNGroup),
  }
  expect((await requestBestOfNCancel("g", host)).phase).toBe("cancelling")
  const [mutation] = host.cancel.mock.calls[0] as unknown as [Record<string, unknown>]
  expect(mutation).toMatchObject({ groupId: "g", expectedVersion: 4 })
  expect(mutation.ownerId).toMatch(/^paired-request:/)
  expect(mutation.ownerId).not.toBe("desktop")
})

it("re-reads after a version race, but never retries a refusal", async () => {
  const host = {
    get: jest.fn().mockResolvedValueOnce(group(1)).mockResolvedValueOnce(group(2)),
    cancel: jest
      .fn()
      .mockRejectedValueOnce(new Error("best-of-N version conflict"))
      .mockResolvedValueOnce(group(3)),
  }
  expect((await requestBestOfNCancel("g", host)).version).toBe(3)
  expect(host.cancel).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 2 }))

  const refusing = {
    get: jest.fn(async () => group(1)),
    cancel: jest.fn(async () => {
      throw new Error("cannot cancel a selected publication")
    }),
  }
  await expect(requestBestOfNCancel("g", refusing)).rejects.toThrow("selected publication")
  expect(refusing.cancel).toHaveBeenCalledTimes(1)
})

it("gives up after repeated races instead of spinning", async () => {
  const host = {
    get: jest.fn(async () => group(1)),
    cancel: jest.fn(async () => {
      throw new Error("best-of-N version conflict")
    }),
  }
  await expect(requestBestOfNCancel("g", host)).rejects.toThrow("version conflict")
  expect(host.cancel).toHaveBeenCalledTimes(3)
})
