/** @jest-environment jsdom */
const captureMock = jest.fn()
jest.mock("@/lib/artifacts/export/raster", () => ({
  ...jest.requireActual<typeof import("@/lib/artifacts/export/raster")>(
    "@/lib/artifacts/export/raster"
  ),
  captureArtifactToPngBlob: (...args: unknown[]) => captureMock(...args),
}))

import { captureArtifactImage } from "./capture"
import {
  ArtifactPreviewNotMountedError,
  ArtifactTooLargeToRasteriseError,
} from "@/lib/artifacts/export/raster"
import type { Artifact } from "@/types"

const artifact = { id: "c1", type: "chart", title: "Sales", content: "{}" } as Artifact
const png = new Blob(["png"], { type: "image/png" })

beforeEach(() => captureMock.mockReset())

it("returns the capture as base64 without the data-URL prefix", async () => {
  captureMock.mockResolvedValueOnce(png)
  const reveal = jest.fn()
  await expect(captureArtifactImage(artifact, { width: 800 }, { reveal })).resolves.toEqual({
    data: "cG5n",
    mimeType: "image/png",
  })
  expect(captureMock).toHaveBeenCalledWith(artifact, { width: 800 })
  expect(reveal).not.toHaveBeenCalled()
})

it("reveals an artifact whose pixels only exist in the dock, waits, and captures again", async () => {
  captureMock
    .mockRejectedValueOnce(new ArtifactPreviewNotMountedError("c1"))
    .mockResolvedValueOnce(png)
  const reveal = jest.fn()
  let checks = 0
  const image = await captureArtifactImage(
    artifact,
    {},
    { reveal, isPreviewMounted: () => ++checks > 1, waitMs: 1_000 }
  )
  expect(reveal).toHaveBeenCalledWith("c1")
  expect(captureMock).toHaveBeenCalledTimes(2)
  expect(image.data).toBe("cG5n")
})

it("gives up with the typed error when the revealed preview never mounts", async () => {
  captureMock.mockRejectedValue(new ArtifactPreviewNotMountedError("c1"))
  await expect(
    captureArtifactImage(
      artifact,
      {},
      { reveal: jest.fn(), isPreviewMounted: () => false, waitMs: 0 }
    )
  ).rejects.toBeInstanceOf(ArtifactPreviewNotMountedError)
  expect(captureMock).toHaveBeenCalledTimes(1)
})

it("does not reveal for any other failure", async () => {
  captureMock.mockRejectedValueOnce(new ArtifactTooLargeToRasteriseError(99_999))
  const reveal = jest.fn()
  await expect(captureArtifactImage(artifact, {}, { reveal })).rejects.toBeInstanceOf(
    ArtifactTooLargeToRasteriseError
  )
  expect(reveal).not.toHaveBeenCalled()
})
