import type { MetadataRoute } from "next"

/**
 * Web App Manifest (Wave 4 / ADR-0026).
 *
 * Next.js's metadata-based manifest API generates `manifest.webmanifest`
 * at build time. Pairs with the Serwist SW (see `app/sw.ts`) so the
 * browser can offer "Install cognia" on web and the desktop Tauri shell
 * gets a manifest for completeness.
 *
 * Icons live under `public/icons/` (192/512 standard + 512 maskable),
 * rasterised from `mobile/resources/splash.png` — the same source that
 * feeds the desktop (`src-tauri/icons/`) and Android (`mipmap-*`) icons.
 * The Apple Touch Icon is served via the Next.js `app/apple-icon.png`
 * file convention and the favicon via `app/favicon.ico`.
 */
// Required by Next.js 16 when `output: "export"` is set in next.config.ts —
// the manifest returns a fully static object so we opt in explicitly.
export const dynamic = "force-static"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "cognia",
    short_name: "cognia",
    description: "Local-first AI companion — chat, workflows, twin, and connectors.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0a0a0a",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  }
}
