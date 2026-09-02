/**
 * Hand an exported template package to the browser as a file.
 *
 * Lifted out of `template-studio.tsx`, where it was a module-private helper, so
 * the squad templates gallery can offer Export without a second copy of the
 * anchor dance. Both surfaces call `service.exportPackage` and both need the
 * same three details right.
 *
 * The anchor is put in the document and revoked on the next task rather than
 * synchronously: some browsers ignore a click on a detached anchor, and
 * revoking the object URL before the download has been handed off cancels it.
 */

/** The extension every exported template package carries. */
export const TEMPLATE_PACKAGE_EXTENSION = ".cognia-template"

/** `<id>-<version>.cognia-template`, the name both surfaces already used. */
export function templatePackageFilename(id: string, version: string): string {
  return `${id}-${version}${TEMPLATE_PACKAGE_EXTENSION}`
}

export function downloadTemplatePackage(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
