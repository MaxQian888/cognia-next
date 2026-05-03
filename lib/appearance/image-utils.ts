"use client"

/**
 * Decode a `File` into pixel dimensions. Lives in its own module so tests
 * can `jest.mock("@/lib/appearance/image-utils")` and bypass jsdom's lack
 * of real image decoding without faking the full `Image` API.
 */
export async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const out = { width: img.naturalWidth, height: img.naturalHeight }
      URL.revokeObjectURL(url)
      resolve(out)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("could not decode image"))
    }
    img.src = url
  })
}
