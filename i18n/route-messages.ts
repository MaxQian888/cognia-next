import type { AbstractIntlMessages } from "next-intl"
import { defaultLocale, type Locale } from "./config"
import { startupMessages } from "./messages"

/**
 * Route-scoped message catalogs.
 *
 * `FullMessagesGate` normally loads a locale's complete catalog (every
 * namespace of the app, ~2 MB for zh-CN). A route that is a standalone
 * document and renders only its own namespace declares a scoped catalog here
 * instead, so a visitor downloads just those strings. The public `/status`
 * page (served alone on status.cognia.cn, ADR-0211) reads only
 * `publicStatus`; the startup namespaces (`loading`, `common`, ...) are
 * already in the main bundle and stay available to anything mounted around
 * the page.
 *
 * Each loader is a static `import()` of one split source file, so the bundler
 * emits one small chunk per locale. Every other route returns `null` and keeps
 * the full catalog.
 */

export type RouteMessageScope = "publicStatus"

const ROUTE_LOADERS: Record<
  RouteMessageScope,
  Record<Locale, () => Promise<AbstractIntlMessages>>
> = {
  publicStatus: {
    en: () =>
      import("./messages/en/publicStatus.json").then((m) => ({
        ...startupMessages.en,
        publicStatus: m.default,
      })),
    "zh-CN": () =>
      import("./messages/zh-CN/publicStatus.json").then((m) => ({
        ...startupMessages["zh-CN"],
        publicStatus: m.default,
      })),
  },
}

/** The scoped catalog a pathname renders with, or null for the full catalog. */
export function routeMessageScope(pathname: string | null | undefined): RouteMessageScope | null {
  if (!pathname) return null
  if (
    pathname === "/status" ||
    pathname === "/status.html" ||
    pathname === "/status/" ||
    pathname.startsWith("/status/")
  ) {
    return "publicStatus"
  }
  return null
}

export function loadRouteMessages(
  scope: RouteMessageScope,
  locale: Locale
): Promise<AbstractIntlMessages> {
  const loaders = ROUTE_LOADERS[scope]
  return (loaders[locale] ?? loaders[defaultLocale])()
}
