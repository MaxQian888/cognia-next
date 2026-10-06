// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata, Viewport } from "next"
// Geist ships as a self-hosted local font package (geist/font/*), so the build
// never fetches from fonts.gstatic.com. This keeps offline / proxied / CI and
// the Tauri + Capacitor static-export builds deterministic; the exposed CSS
// variables (--font-geist-sans / --font-geist-mono) are identical to what
// next/font/google emitted, so globals.css needs no change.
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import Script from "next/script"
import { getLocale } from "next-intl/server"
import { BOOT_SCRIPT } from "@/lib/appearance/boot-script"
import { AppRuntime } from "@/components/runtime/app-runtime"
import { WebVitalsReporter } from "@/components/providers/initializers/web-vitals-reporter"
import "./globals.css"

export const metadata: Metadata = {
  title: "Cognia",
  description: "Local-first AI companion — chat, workflows, twin, and connectors.",
  // iOS "Add to Home Screen": pre-16.4 Safari reads these meta tags instead of
  // the web app manifest. `capable` + icon (app/apple-icon.png convention)
  // give the iOS PWA a standalone window and the right splash name.
  appleWebApp: {
    capable: true,
    title: "Cognia",
    statusBarStyle: "black-translucent",
  },
}

// `viewport-fit: cover` lets the Capacitor WebView paint into the iPhone notch
// and below the Android gesture indicator. Combined with the `.safe-area-*`
// utilities in globals.css (M4.3 / #47) this gives the mobile shell room to
// breathe without leaking into the unsafe edges. Width / scale defaults match
// the Next.js conventions; on desktop the value is a no-op.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Browser chrome tint (Safari status bar, Android task switcher). Matches
  // the manifest's background/theme pair rather than a single fixed color.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  // Keyboard avoidance, part 1: in Android Chrome (phone browser / PWA) this
  // makes the on-screen keyboard *resize* the layout viewport instead of
  // overlaying it, the same shape the Capacitor shell gets from the OS frame
  // resize. Part 2 is the page-wide keyboard store
  // (`lib/capacitor/keyboard-viewport.ts`): it measures the visible height
  // from `visualViewport` + the native Keyboard events and the compact shell
  // sizes its viewport-owning column from that, so the composer sits on the
  // keyboard whether the WebView resized, `100dvh` lagged, or the browser
  // overlaid the keyboard (iOS).
  interactiveWidget: "resizes-content",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const locale = await getLocale()
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* FOUC mitigation — applies a mirrored CSS-var snapshot from
            localStorage before React hydrates so custom themes don't
            flash the default palette on first paint. Owns CSS vars
            only; next-themes still owns the `dark` class. */}
        <Script
          id="cognia-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }}
        />
      </head>
      <body className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
        <WebVitalsReporter />
        <AppRuntime>{children}</AppRuntime>
      </body>
    </html>
  )
}
