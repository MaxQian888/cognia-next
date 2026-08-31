/** Trigger a browser download and always release the temporary object URL. */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.rel = "noopener"
    anchor.style.display = "none"
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    URL.revokeObjectURL(url)
  }
}
