import type { MetadataRoute } from "next"

/**
 * Web App Manifest (Wave 4 / ADR-0026).
 *
 * Next.js's metadata-based manifest API generates `manifest.webmanifest`
 * at build time. Pairs with the Serwist SW (see `app/sw.ts`) so the
 * browser can offer "Install cognia" on web and the desktop Tauri shell
 * gets a manifest for completeness.
 *
 * Icons live under `public/icons/`. Currently shipped as SVG placeholders
 * (see public/icons/README.md) — modern browsers handle SVG manifests
 * since Chrome 93 + Safari 16.4. Production PNG variants (192/512/512-
 * maskable/180-apple) are a follow-up.
 */
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
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/icons/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  }
}
