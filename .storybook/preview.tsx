import * as React from "react"
import type { Preview, Decorator } from "@storybook/nextjs-vite"
import { NextIntlClientProvider } from "next-intl"
import { ThemeProvider } from "next-themes"

import enMessages from "../i18n/messages/en.json"
import zhMessages from "../i18n/messages/zh-CN.json"
import { TooltipProvider } from "../components/ui/tooltip"

import "../app/globals.css"

const MESSAGES: Record<string, Record<string, unknown>> = {
  en: enMessages as Record<string, unknown>,
  "zh-CN": zhMessages as Record<string, unknown>,
}

// Mirrors the prod provider stack (app/layout.tsx): next-intl → next-themes →
// TooltipProvider. `isTauri()`/`isCapacitor()` return false in this plain
// browser, so components render their web path with no extra mocking.
function Providers({
  locale,
  theme,
  children,
}: {
  locale: string
  theme: string
  children: React.ReactNode
}) {
  // next-themes owns the `dark` class in prod; apply it directly here so the
  // toolbar toggle drives the `&:is(.dark *)` variant in globals.css.
  React.useEffect(() => {
    const root = document.documentElement
    root.classList.toggle("dark", theme === "dark")
    return () => root.classList.remove("dark")
  }, [theme])

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={MESSAGES[locale] ?? enMessages}
      timeZone="UTC"
    >
      <ThemeProvider attribute="class" forcedTheme={theme} enableSystem={false}>
        <TooltipProvider>{children}</TooltipProvider>
      </ThemeProvider>
    </NextIntlClientProvider>
  )
}

const withProviders: Decorator = (Story, context) => (
  <Providers
    locale={(context.globals.locale as string) ?? "en"}
    theme={(context.globals.theme as string) ?? "light"}
  >
    <Story />
  </Providers>
)

const preview: Preview = {
  decorators: [withProviders],
  parameters: {
    layout: "centered",
    // The theme decorator owns the background via globals.css.
    backgrounds: { disable: true },
    // @storybook/nextjs App Router mocks — chat components read `next/navigation`
    // (useRouter/usePathname) and throw without this.
    nextjs: { appDirectory: true },
  },
  initialGlobals: {
    locale: "en",
    theme: "light",
  },
  globalTypes: {
    locale: {
      description: "Active locale (next-intl)",
      toolbar: {
        title: "Locale",
        icon: "globe",
        items: [
          { value: "en", title: "English" },
          { value: "zh-CN", title: "简体中文" },
        ],
        dynamicTitle: true,
      },
    },
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
}

export default preview
