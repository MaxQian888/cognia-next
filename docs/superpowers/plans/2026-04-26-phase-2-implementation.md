# Phase 2 — i18n + Theme + E2E + CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the starter from "minimal foundation" to "opinionated kit" by adding next-intl i18n (no URL routing, static-export friendly), next-themes theme switcher, Playwright E2E testing, and 4 CI enhancements (Codecov + CodeQL + Release-Please + E2E in CI).

**Architecture:** 4 sequential segments, each commits independently. Segment 1 (i18n) → Segment 2 (theme, depends on i18n for ARIA labels) → Segment 3 (E2E, tests both) → Segment 4 (CI, includes E2E job). All UI runtime state stays client-side (localStorage + cookie) so static export keeps working.

**Tech Stack:** next-intl 3.x / next-themes 0.4.x / @playwright/test 1.5x / serve 14.x / codecov-action v5 / github/codeql-action v3 / googleapis/release-please-action v4

**Spec:** `docs/superpowers/specs/2026-04-26-phase-2-design.md`

**Critical constraint (from spec):** Tauri uses `output: "export"`. next-intl runs in **"without i18n routing" mode** with build-time default locale (server) + client-side `LocaleProvider` for runtime switching. No `[locale]` URL segments.

---

## File Structure

### Files to CREATE

| Path                                   | Responsibility                                                        |
| -------------------------------------- | --------------------------------------------------------------------- |
| `i18n/config.ts`                       | `locales` const, `defaultLocale`, `Locale` type                       |
| `i18n/messages/en.json`                | English UI strings                                                    |
| `i18n/messages/zh-CN.json`             | Simplified Chinese UI strings                                         |
| `i18n/messages.ts`                     | Barrel: bundle both message files for client provider                 |
| `i18n/request.ts`                      | next-intl getRequestConfig — returns build-time default               |
| `hooks/use-locale.ts`                  | Client hook: read/write locale (localStorage + cookie + nav fallback) |
| `hooks/use-locale.test.ts`             | Tests for useLocale                                                   |
| `components/locale-provider.tsx`       | Client wrapper around NextIntlClientProvider                          |
| `components/locale-switcher.tsx`       | en ⇄ 中 toggle button                                                 |
| `components/locale-switcher.test.tsx`  | Tests for LocaleSwitcher                                              |
| `components/theme-provider.tsx`        | Wraps next-themes ThemeProvider with defaults                         |
| `components/theme-toggle.tsx`          | Sun/Moon icon button                                                  |
| `components/theme-toggle.test.tsx`     | Tests for ThemeToggle                                                 |
| `playwright.config.ts`                 | Playwright config (Chromium, port 3001, build+serve)                  |
| `e2e/smoke.spec.ts`                    | 2 smoke tests                                                         |
| `e2e/theme-toggle.spec.ts`             | 1 theme test                                                          |
| `e2e/locale-switcher.spec.ts`          | 1 locale test                                                         |
| `codecov.yml`                          | Codecov config (ignores, target)                                      |
| `.github/workflows/codeql.yml`         | CodeQL JS/TS scan                                                     |
| `.github/workflows/release-please.yml` | Release-Please workflow                                               |
| `.github/workflows/e2e.yml`            | E2E workflow (called from ci.yml)                                     |
| `.release-please-manifest.json`        | Tracks current version                                                |
| `.release-please-config.json`          | Defines extra-files sync (Cargo.toml + tauri.conf.json)               |

### Files to MODIFY

| Path                         | Change                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `app/layout.tsx`             | Wrap children with LocaleProvider + ThemeProvider; add `suppressHydrationWarning`                            |
| `app/page.tsx`               | Replace hardcoded English with `useTranslations()`; add demo controls dock with LocaleSwitcher + ThemeToggle |
| `app/page.test.tsx`          | Wrap render with NextIntlClientProvider mock (or rely on jest.setup.ts global mock)                          |
| `jest.setup.ts`              | Inject NextIntlClientProvider mock for all tests                                                             |
| `next.config.ts`             | Wrap with `createNextIntlPlugin()`                                                                           |
| `package.json`               | Add deps + scripts (test:e2e family)                                                                         |
| `pnpm-lock.yaml`             | Auto-updated                                                                                                 |
| `.gitignore`                 | Add Playwright artifact dirs                                                                                 |
| `src-tauri/Cargo.toml`       | Add `# x-release-please-version` annotation on version line                                                  |
| `.github/workflows/test.yml` | Add Codecov upload step after coverage                                                                       |
| `.github/workflows/ci.yml`   | Add e2e job dispatch                                                                                         |
| `README.md` + `README_zh.md` | New "Internationalization", "Theming", "E2E Testing" sections + CI/CD updates                                |
| `CI_CD.md`                   | Sync 4 new CI capabilities                                                                                   |

---

# Segment 1 — i18n (next-intl, "no URL routing" mode)

## Task 1: Install next-intl + create i18n config files

**Files:**

- Create: `i18n/config.ts`, `i18n/messages/en.json`, `i18n/messages/zh-CN.json`, `i18n/messages.ts`, `i18n/request.ts`

- [ ] **Step 1: Install next-intl**

Run: `pnpm add next-intl@^3`
Expected: Added to `dependencies`. pnpm-lock.yaml updates.

- [ ] **Step 2: Create `i18n/config.ts`**

```ts
export const locales = ["en", "zh-CN"] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = "en"
```

- [ ] **Step 3: Create `i18n/messages/en.json`**

```json
{
  "page": {
    "title": "React Quick Starter",
    "subtitle": "Next.js 16 + Tauri 2.9 + Tailwind v4 + shadcn/ui",
    "instructionEdit": "Get started by editing",
    "instructionSave": "Save and see your changes instantly.",
    "deployNow": "Deploy now",
    "readDocs": "Read our docs"
  },
  "themeToggle": {
    "label": "Toggle theme",
    "switchToLight": "Switch to light mode",
    "switchToDark": "Switch to dark mode"
  },
  "localeSwitcher": {
    "label": "Switch language",
    "en": "EN",
    "zh-CN": "中"
  },
  "tauriDemo": {
    "buttonLabel": "Call Rust greet()"
  }
}
```

- [ ] **Step 4: Create `i18n/messages/zh-CN.json`**

```json
{
  "page": {
    "title": "React 快速启动模板",
    "subtitle": "Next.js 16 + Tauri 2.9 + Tailwind v4 + shadcn/ui",
    "instructionEdit": "编辑开始",
    "instructionSave": "保存即可立即看到变化。",
    "deployNow": "立即部署",
    "readDocs": "阅读文档"
  },
  "themeToggle": {
    "label": "切换主题",
    "switchToLight": "切换到浅色模式",
    "switchToDark": "切换到深色模式"
  },
  "localeSwitcher": {
    "label": "切换语言",
    "en": "EN",
    "zh-CN": "中"
  },
  "tauriDemo": {
    "buttonLabel": "调用 Rust greet()"
  }
}
```

- [ ] **Step 5: Create `i18n/messages.ts`** (barrel for client-side bundling)

```ts
import en from "./messages/en.json"
import zhCN from "./messages/zh-CN.json"
import type { Locale } from "./config"

export type Messages = typeof en

export const allMessages: Record<Locale, Messages> = {
  en,
  "zh-CN": zhCN as Messages,
}
```

- [ ] **Step 6: Create `i18n/request.ts`** (next-intl server-side default)

```ts
import { getRequestConfig } from "next-intl/server"
import { defaultLocale } from "./config"

// Static export: build-time renders only the default locale.
// Runtime locale switching is handled client-side by LocaleProvider.
export default getRequestConfig(async () => {
  return {
    locale: defaultLocale,
    messages: (await import(`./messages/${defaultLocale}.json`)).default,
  }
})
```

- [ ] **Step 7: Verify JSON syntax**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('i18n/messages/en.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('i18n/messages/zh-CN.json','utf8'))"
```

Expected: silent success.

---

## Task 2: Wrap next.config.ts with next-intl plugin

**Files:**

- Modify: `next.config.ts`

- [ ] **Step 1: Replace `next.config.ts` contents**

```ts
import createNextIntlPlugin from "next-intl/plugin"
import type { NextConfig } from "next"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const isProd = process.env.NODE_ENV === "production"
const internalHost = process.env.TAURI_DEV_HOST || "localhost"

// Enable static export for Tauri production builds.
const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
}

export default withNextIntl(nextConfig)
```

- [ ] **Step 2: Verify build still works**

Run: `pnpm build 2>&1 | tail -10`
Expected: PASS — `out/` generated. May see "Loading messages from i18n/request.ts" or similar in output.

If build fails due to `useTranslations()` being called somewhere without provider, that's expected — Task 6 wires the provider. For now just confirm `next-intl/plugin` integrates cleanly.

---

## Task 3: TDD `hooks/use-locale.ts`

**Files:**

- Create: `hooks/use-locale.ts`
- Test: `hooks/use-locale.test.ts`

- [ ] **Step 1: Write the failing test** — `hooks/use-locale.test.ts`

```ts
import { renderHook, act } from "@testing-library/react"
import { useLocale } from "./use-locale"

describe("useLocale", () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.cookie = "NEXT_LOCALE=; path=/; max-age=0"
  })

  it("returns defaultLocale (en) on first render with no storage", () => {
    const { result } = renderHook(() => useLocale())
    expect(result.current.locale).toBe("en")
  })

  it("reads zh-CN from localStorage on mount", () => {
    window.localStorage.setItem("NEXT_LOCALE", "zh-CN")
    const { result } = renderHook(() => useLocale())
    expect(result.current.locale).toBe("zh-CN")
  })

  it("ignores invalid stored locale and falls back to default", () => {
    window.localStorage.setItem("NEXT_LOCALE", "fr")
    const { result } = renderHook(() => useLocale())
    expect(result.current.locale).toBe("en")
  })

  it("setLocale writes to localStorage and cookie", () => {
    const { result } = renderHook(() => useLocale())
    act(() => result.current.setLocale("zh-CN"))
    expect(result.current.locale).toBe("zh-CN")
    expect(window.localStorage.getItem("NEXT_LOCALE")).toBe("zh-CN")
    expect(document.cookie).toContain("NEXT_LOCALE=zh-CN")
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `pnpm test -- hooks/use-locale.test.ts`
Expected: FAIL — "Cannot find module './use-locale'".

- [ ] **Step 3: Implement `hooks/use-locale.ts`**

```ts
"use client"

import { useCallback, useEffect, useState } from "react"
import { defaultLocale, locales, type Locale } from "@/i18n/config"

const STORAGE_KEY = "NEXT_LOCALE"

function isValidLocale(value: string | null | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value)
}

function detectInitial(): Locale {
  if (typeof window === "undefined") return defaultLocale
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isValidLocale(stored)) return stored
  const navLang = window.navigator.language
  if (isValidLocale(navLang)) return navLang
  const family = navLang.split("-")[0]
  const match = locales.find((l) => l.startsWith(family))
  return match ?? defaultLocale
}

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale)

  useEffect(() => {
    setLocaleState(detectInitial())
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next)
      document.cookie = `${STORAGE_KEY}=${next}; path=/; max-age=${60 * 60 * 24 * 365}`
    }
  }, [])

  return { locale, setLocale }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test -- hooks/use-locale.test.ts`
Expected: PASS — 4 tests.

---

## Task 4: Create `components/locale-provider.tsx`

**Files:**

- Create: `components/locale-provider.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client"

import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { useLocale } from "@/hooks/use-locale"
import { allMessages } from "@/i18n/messages"

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { locale } = useLocale()
  return (
    <NextIntlClientProvider locale={locale} messages={allMessages[locale]}>
      {children}
    </NextIntlClientProvider>
  )
}
```

(No test file — this is a 10-line wrapper around a third-party provider; integration covered by E2E.)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm typecheck 2>&1 | tail -5`
Expected: PASS (note: app/page.tsx will fail later when we add `useTranslations()` without provider being wired — that's Task 6).

---

## Task 5: TDD `components/locale-switcher.tsx`

**Files:**

- Create: `components/locale-switcher.tsx`
- Test: `components/locale-switcher.test.tsx`

- [ ] **Step 1: Write the failing test** — `components/locale-switcher.test.tsx`

```tsx
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { LocaleSwitcher } from "./locale-switcher"
import enMessages from "@/i18n/messages/en.json"

function renderWithProvider(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("LocaleSwitcher", () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.cookie = "NEXT_LOCALE=; path=/; max-age=0"
  })

  it("renders the EN label by default", () => {
    renderWithProvider(<LocaleSwitcher />)
    const button = screen.getByRole("button", { name: /switch language/i })
    expect(button).toHaveTextContent("中")
  })

  it("clicking the button writes zh-CN to storage", async () => {
    const user = userEvent.setup()
    renderWithProvider(<LocaleSwitcher />)
    const button = screen.getByRole("button", { name: /switch language/i })
    await user.click(button)
    expect(window.localStorage.getItem("NEXT_LOCALE")).toBe("zh-CN")
    expect(document.cookie).toContain("NEXT_LOCALE=zh-CN")
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `pnpm test -- components/locale-switcher.test.tsx`
Expected: FAIL — "Cannot find module './locale-switcher'".

- [ ] **Step 3: Implement `components/locale-switcher.tsx`**

```tsx
"use client"

import { useTranslations } from "next-intl"
import { useLocale } from "@/hooks/use-locale"
import { Button } from "@/components/ui/button"
import type { Locale } from "@/i18n/config"

export function LocaleSwitcher() {
  const t = useTranslations("localeSwitcher")
  const { locale, setLocale } = useLocale()

  // Toggle: en → zh-CN → en
  const next: Locale = locale === "en" ? "zh-CN" : "en"
  // Show the label of the OTHER locale (what you'd switch to)
  const label = next === "zh-CN" ? t("zh-CN") : t("en")

  return (
    <Button variant="ghost" size="icon-sm" onClick={() => setLocale(next)} aria-label={t("label")}>
      {label}
    </Button>
  )
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test -- components/locale-switcher.test.tsx`
Expected: PASS — 2 tests.

---

## Task 6: Refactor app/layout.tsx + app/page.tsx + tests for i18n

**Files:**

- Modify: `app/layout.tsx`
- Modify: `app/page.tsx`
- Modify: `app/page.test.tsx` AND/OR `jest.setup.ts`

### Sub-Step 6a: Update `jest.setup.ts` to provide a default NextIntlClientProvider

- [ ] **Step 1: Read current `jest.setup.ts`** to see current structure.

- [ ] **Step 2: Append at the end** (don't replace existing setup):

```ts
// Default messages for tests that render components using useTranslations()
// without explicitly wrapping in NextIntlClientProvider.
import enMessages from "@/i18n/messages/en.json"

jest.mock("next-intl", () => {
  const actual = jest.requireActual("next-intl")
  return {
    ...actual,
    useTranslations: (namespace?: string) => {
      return (key: string) => {
        const path = namespace ? `${namespace}.${key}` : key
        const parts = path.split(".")
        let value: unknown = enMessages
        for (const p of parts) {
          if (typeof value === "object" && value !== null && p in value) {
            value = (value as Record<string, unknown>)[p]
          } else {
            return path
          }
        }
        return typeof value === "string" ? value : path
      }
    },
  }
})
```

This mock makes `useTranslations()` return a function that resolves keys against the English messages at import time. Tests that need different locales can still wrap explicitly.

### Sub-Step 6b: Update `app/layout.tsx`

- [ ] **Step 3: Read current `app/layout.tsx`** (it has the CSP comment at top + Geist fonts + metadata).

- [ ] **Step 4: Update file with this content** (preserves CSP comment + Geist fonts; adds providers):

```tsx
// NOTE: The Tauri production CSP is set in src-tauri/tauri.conf.json.
// If you call an external API from the browser, add its origin to the
// `connect-src` directive there, otherwise the request will be blocked.
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { LocaleProvider } from "@/components/locale-provider"
import { ThemeProvider } from "@/components/theme-provider"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "React Quick Starter",
  description: "Next.js 16 + Tauri 2.9 + Tailwind v4 + shadcn/ui",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <LocaleProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  )
}
```

**Note**: This imports `ThemeProvider` from `@/components/theme-provider` which doesn't exist yet — Task 8 creates it. After this step, `pnpm typecheck` will fail. That's OK — we tolerate temporarily-broken state across tasks within the same segment chain. T11 verifies everything.

If you prefer a verifiable interim state: temporarily comment out the `<ThemeProvider>` wrapping for now:

```tsx
<LocaleProvider>{children}</LocaleProvider>
```

Then T8 will add it back.

### Sub-Step 6c: Refactor `app/page.tsx` to use translations

- [ ] **Step 5: Read current `app/page.tsx`** to identify all hardcoded English strings.

- [ ] **Step 6: Replace hardcoded strings with `t(...)` calls**

The current page has phrases like "By editing", "Save and see your changes instantly", "Deploy now", "Read our docs" etc. Wrap the page with translations.

Add `"use client"` at top (since we're using `useTranslations` which works in both, but to avoid ambiguity).

Locate each hardcoded string and replace with the corresponding translation key from `i18n/messages/en.json`. Map:

- `By editing` → `t("instructionEdit")`
- `Save and see your changes instantly.` → `t("instructionSave")`
- `Deploy now` → `t("deployNow")`
- `Read our docs` → `t("readDocs")`

If page has a heading/title, use `t("title")`; if subtitle, `t("subtitle")`.

For page heading example, your file should now include at the top:

```tsx
"use client"

import { useTranslations } from "next-intl"
// ... other imports unchanged
import { TauriDemo } from "@/components/tauri-demo"

export default function Home() {
  const t = useTranslations("page")
  // ... rest of component using {t("instructionEdit")} etc
}
```

**KEEP the existing `<TauriDemo />` placement**.

(The exact restructuring depends on the current page DOM. Just make sure: every hardcoded English string in the JSX is replaced with the corresponding `t(key)` call.)

### Sub-Step 6d: Update `app/page.test.tsx`

- [ ] **Step 7: Read current `app/page.test.tsx`** to see what assertions exist.

The existing tests probably assert on text content like "Deploy now" or "Save and see". With the jest.setup.ts mock from Step 2, `useTranslations` returns the EN message — so existing assertions on English text should still pass without code changes.

If any assertion fails because the exact wording changed (we added explicit `title` and `subtitle` keys that may differ slightly from prior hardcoded text), update the assertion to match the new English from `i18n/messages/en.json`.

- [ ] **Step 8: Run all gates**

```bash
pnpm format:check 2>&1 | tail -3
pnpm lint 2>&1 | tail -3
pnpm typecheck 2>&1 | tail -3
pnpm test 2>&1 | tail -8
```

Expected: all pass. Test count should be 25 (existing) + 4 (use-locale) + 2 (locale-switcher) = **31**.

If `typecheck` fails because of `<ThemeProvider>` not existing, comment it out temporarily per the note in Sub-Step 6b.

---

## Task 7: Segment 1 verification + commit

- [ ] **Step 1: Run all verifications**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build 2>&1 | tail -5
```

If `pnpm build` fails because i18n setup needs `out/` regen or Cargo, fix and re-run.

- [ ] **Step 2: Commit Segment 1**

```bash
git add i18n/ hooks/ components/locale-provider.tsx components/locale-switcher.tsx components/locale-switcher.test.tsx app/layout.tsx app/page.tsx app/page.test.tsx jest.setup.ts next.config.ts package.json pnpm-lock.yaml
```

(Do NOT add `theme-provider.tsx` yet — Task 8 creates it. If you commented out `<ThemeProvider>` in `layout.tsx` for Task 6, this commit ships with that comment; Task 8 uncomments.)

```bash
git commit -m "feat(i18n): add next-intl with en + zh-CN, no-routing mode

- next-intl 3 in 'without i18n routing' mode (works with Tauri's
  output: 'export'; URL routing disabled because Tauri webview has
  no public URL paths)
- i18n/config.ts: locales = ['en', 'zh-CN'], default = 'en'
- i18n/messages/{en,zh-CN}.json: ~15 UI strings covering page demo,
  theme toggle ARIA, locale switcher labels, Tauri demo button
- i18n/messages.ts: barrel for client-side bundling
- i18n/request.ts: server-side default-locale config
- next.config.ts: wrapped with createNextIntlPlugin
- hooks/use-locale.ts: localStorage + cookie persistence; falls back
  to navigator.language; rejects invalid locales (TDD, 4 tests)
- components/locale-provider.tsx: client-side switching wrapper
  around NextIntlClientProvider
- components/locale-switcher.tsx: 2-state toggle button (TDD, 2
  tests)
- app/layout.tsx: wraps children with LocaleProvider; metadata
  updated from boilerplate
- app/page.tsx: hardcoded strings replaced with useTranslations
- jest.setup.ts: global useTranslations mock returns EN messages so
  existing tests don't need per-test provider wrap"
```

---

# Segment 2 — Theme Switcher (next-themes)

## Task 8: Install next-themes + create theme provider

**Files:**

- Create: `components/theme-provider.tsx`
- Modify: `app/layout.tsx` (uncomment ThemeProvider if commented out in T6)

- [ ] **Step 1: Install next-themes**

Run: `pnpm add next-themes@^0.4`
Expected: added to dependencies.

- [ ] **Step 2: Create `components/theme-provider.tsx`**

```tsx
"use client"

import { ThemeProvider as NextThemesProvider } from "next-themes"
import type { ReactNode } from "react"

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}
```

- [ ] **Step 3: If `<ThemeProvider>` was commented out in `app/layout.tsx` during T6, uncomment it now.**

The relevant block should read:

```tsx
<LocaleProvider>
  <ThemeProvider>{children}</ThemeProvider>
</LocaleProvider>
```

- [ ] **Step 4: Verify**

```bash
pnpm typecheck 2>&1 | tail -3
pnpm test 2>&1 | tail -5
```

Expected: PASS, 31/31 tests.

---

## Task 9: TDD `components/theme-toggle.tsx`

**Files:**

- Create: `components/theme-toggle.tsx`
- Test: `components/theme-toggle.test.tsx`

- [ ] **Step 1: Write the failing test** — `components/theme-toggle.test.tsx`

```tsx
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ThemeProvider } from "next-themes"
import { ThemeToggle } from "./theme-toggle"

function renderWithTheme(ui: React.ReactNode, initialTheme = "light") {
  return render(
    <ThemeProvider attribute="class" defaultTheme={initialTheme} enableSystem={false}>
      {ui}
    </ThemeProvider>
  )
}

describe("ThemeToggle", () => {
  it("renders a toggle button with theme aria-label", () => {
    renderWithTheme(<ThemeToggle />)
    expect(screen.getByRole("button", { name: /toggle theme/i })).toBeInTheDocument()
  })

  it("clicking toggles between light and dark", async () => {
    const user = userEvent.setup()
    const { container } = renderWithTheme(<ThemeToggle />, "light")
    const button = screen.getByRole("button", { name: /toggle theme/i })

    // Initial: light → button click switches to dark
    await user.click(button)
    // next-themes writes to <html class>, but the test root is just a div;
    // we instead assert via the data attribute next-themes mirrors on document.documentElement
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    await user.click(button)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test, verify fail**

Run: `pnpm test -- components/theme-toggle.test.tsx`
Expected: FAIL — "Cannot find module './theme-toggle'".

- [ ] **Step 3: Implement `components/theme-toggle.tsx`**

```tsx
"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  const t = useTranslations("themeToggle")
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // Avoid hydration mismatch — only render the actual icon after mount
  useEffect(() => setMounted(true), [])

  const isDark = mounted && resolvedTheme === "dark"
  const next = isDark ? "light" : "dark"

  return (
    <Button variant="ghost" size="icon-sm" onClick={() => setTheme(next)} aria-label={t("label")}>
      {mounted ? (
        isDark ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )
      ) : (
        // Empty placeholder during SSR/hydration to keep button size stable
        <span className="h-4 w-4" />
      )}
    </Button>
  )
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test -- components/theme-toggle.test.tsx`
Expected: PASS — 2 tests.

---

## Task 10: Add demo controls dock to app/page.tsx

**Files:**

- Modify: `app/page.tsx`

- [ ] **Step 1: Read current `app/page.tsx`** to find the outermost wrapper.

- [ ] **Step 2: Add imports at the top** (alongside existing):

```tsx
import { LocaleSwitcher } from "@/components/locale-switcher"
import { ThemeToggle } from "@/components/theme-toggle"
```

- [ ] **Step 3: Add the demo controls dock**

Inside the page's outermost layout `<div>` or `<main>`, as the FIRST child (before everything else), insert:

```tsx
<div className="fixed top-4 right-4 z-50 flex gap-1 rounded-md border bg-background/80 p-1 backdrop-blur">
  <LocaleSwitcher />
  <ThemeToggle />
</div>
```

This positions the dock at the top-right corner of the viewport with a translucent background.

- [ ] **Step 4: Run gates**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build 2>&1 | tail -5
```

Expected: all pass. Tests: 33 (31 + 2 from theme-toggle).

---

## Task 11: Segment 2 verification + commit

- [ ] **Step 1: Final Segment 2 verification**

Already done in Task 10 Step 4. Confirm one more time everything green.

- [ ] **Step 2: Commit Segment 2**

```bash
git add components/theme-provider.tsx components/theme-toggle.tsx components/theme-toggle.test.tsx app/layout.tsx app/page.tsx package.json pnpm-lock.yaml
git commit -m "feat(theme): add next-themes with system default + Sun/Moon toggle

- next-themes 0.4 in attribute='class' mode (matches globals.css's
  existing .dark variant; defaultTheme='system' so users keep their
  OS preference until they explicitly toggle)
- components/theme-provider.tsx: thin wrapper with locked-in
  defaults (attribute='class', enableSystem,
  disableTransitionOnChange)
- components/theme-toggle.tsx: lucide Sun/Moon button with mounted
  guard to avoid hydration mismatch (TDD, 2 tests)
- app/layout.tsx: ThemeProvider wraps children inside LocaleProvider
- app/page.tsx: top-right fixed dock containing LocaleSwitcher +
  ThemeToggle"
```

---

# Segment 3 — E2E (Playwright)

## Task 12: Install Playwright + serve, scaffolding

**Files:**

- Create: `playwright.config.ts`
- Modify: `package.json` (scripts + devDeps)
- Modify: `.gitignore`

- [ ] **Step 1: Install Playwright + serve**

Run: `pnpm add -D @playwright/test@^1 serve@^14`
Expected: both added to devDependencies.

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test"

const PORT = 3001
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: `pnpm build && pnpm exec serve out -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
```

- [ ] **Step 3: Append to `.gitignore`**

Find the existing `.gitignore` and add at the end:

```
# Playwright
/playwright-report
/test-results
/blob-report
/playwright/.cache
```

- [ ] **Step 4: Add scripts to `package.json`** (preserving existing entries)

Add 3 new scripts:

```json
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui",
"test:e2e:install": "playwright install --with-deps chromium"
```

(Place them after `test:coverage` for grouping.)

- [ ] **Step 5: Install Chromium browser**

Run: `pnpm test:e2e:install 2>&1 | tail -10`
Expected: downloads Chromium for Playwright. May take 2-3 minutes first time.

On Windows, `--with-deps` is a no-op (Linux-only); the download succeeds without it.

---

## Task 13: Write 4 E2E specs

**Files:**

- Create: `e2e/smoke.spec.ts`, `e2e/theme-toggle.spec.ts`, `e2e/locale-switcher.spec.ts`

- [ ] **Step 1: Create `e2e/smoke.spec.ts`**

```ts
import { test, expect } from "@playwright/test"

test.describe("smoke", () => {
  test("page loads with main heading", async ({ page }) => {
    await page.goto("/")
    // Page should render the main title from i18n (default locale = en)
    await expect(page.locator("body")).toContainText("React Quick Starter")
  })

  test("tauri demo is hidden in web mode", async ({ page }) => {
    await page.goto("/")
    // TauriDemo renders null when isTauri() returns false (which is true in a regular browser)
    await expect(page.getByRole("button", { name: /Call Rust greet/i })).toHaveCount(0)
  })
})
```

- [ ] **Step 2: Create `e2e/theme-toggle.spec.ts`**

```ts
import { test, expect } from "@playwright/test"

test.describe("theme toggle", () => {
  test("clicking toggles .dark class on <html>", async ({ page }) => {
    await page.goto("/")

    // Force a known starting state by setting localStorage
    await page.evaluate(() => {
      window.localStorage.setItem("theme", "light")
    })
    await page.reload()

    const html = page.locator("html")
    await expect(html).not.toHaveClass(/dark/)

    await page.getByRole("button", { name: /toggle theme/i }).click()
    await expect(html).toHaveClass(/dark/)

    await page.getByRole("button", { name: /toggle theme/i }).click()
    await expect(html).not.toHaveClass(/dark/)
  })
})
```

- [ ] **Step 3: Create `e2e/locale-switcher.spec.ts`**

```ts
import { test, expect } from "@playwright/test"

test.describe("locale switcher", () => {
  test("clicking switches page text from EN to zh-CN", async ({ page }) => {
    await page.goto("/")

    // Default locale (en): the page should show English instructions
    await expect(page.locator("body")).toContainText("Get started by editing")

    // Click the language switcher button
    await page.getByRole("button", { name: /switch language/i }).click()

    // Wait for re-render, then assert Chinese text appears
    await expect(page.locator("body")).toContainText("编辑开始")
  })
})
```

- [ ] **Step 4: Run all E2E tests**

Run: `pnpm test:e2e 2>&1 | tail -30`
Expected: 4 tests pass. Total runtime should be < 60s (build is the bulk; tests themselves < 30s).

If a test times out on the build step, the timeout in `playwright.config.ts` is 180s — should be enough. If exceeded, increase.

If the locale switch test fails because the click doesn't trigger a re-render visibly fast enough, add `await page.waitForTimeout(100)` after the click.

---

## Task 14: Segment 3 verification + commit

- [ ] **Step 1: Run all gates one more time**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test  # jest unit tests
pnpm test:e2e  # playwright
```

Expected: all pass.

- [ ] **Step 2: Commit Segment 3**

```bash
git add playwright.config.ts e2e/ .gitignore package.json pnpm-lock.yaml
git commit -m "test(e2e): add Playwright with 4 smoke specs

- @playwright/test 1.x + serve 14.x (devDeps)
- playwright.config.ts: Chromium-only, port 3001, webServer auto-runs
  pnpm build && serve out -p 3001 so tests run against the actual
  static export (the same artifact Tauri loads)
- e2e/smoke.spec.ts: 2 tests (page renders, TauriDemo hidden in web)
- e2e/theme-toggle.spec.ts: clicking toggle adds/removes .dark class
- e2e/locale-switcher.spec.ts: switching locale changes page text
- .gitignore: Playwright artifact dirs
- 3 new scripts: test:e2e, test:e2e:ui, test:e2e:install"
```

---

# Segment 4 — CI Enhancements (Codecov + CodeQL + Release-Please + E2E in CI)

## Task 15: Codecov coverage upload

**Files:**

- Create: `codecov.yml`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Create `codecov.yml`**

```yaml
coverage:
  status:
    project:
      default:
        target: 70%
        threshold: 2%
    patch:
      default:
        target: 70%

ignore:
  - "e2e/**"
  - "docs/**"
  - "__mocks__/**"
  - "src-tauri/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"

comment:
  layout: "reach,diff,flags,tree"
  behavior: default
  require_changes: false
```

- [ ] **Step 2: Read `.github/workflows/test.yml`** to find the coverage step.

- [ ] **Step 3: Add Codecov upload step** AFTER the existing `pnpm test:coverage` step (or wherever coverage is generated). Insert this YAML block:

```yaml
- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v5
  with:
    files: ./coverage/lcov.info
    fail_ci_if_error: false
    token: ${{ secrets.CODECOV_TOKEN }}
  continue-on-error: true
```

(`fail_ci_if_error: false` and `continue-on-error: true` make this resilient — public repos work tokenless; private repos that haven't set the secret won't break CI.)

---

## Task 16: CodeQL workflow

**Files:**

- Create: `.github/workflows/codeql.yml`

- [ ] **Step 1: Create the file with EXACTLY:**

```yaml
name: CodeQL

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
  schedule:
    - cron: "0 6 * * 1" # Mondays 06:00 UTC

permissions:
  actions: read
  contents: read
  security-events: write

jobs:
  analyze:
    name: Analyze
    runs-on: ubuntu-latest
    timeout-minutes: 30

    strategy:
      fail-fast: false
      matrix:
        language: [javascript-typescript]

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}
          queries: security-and-quality

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:${{ matrix.language }}"
```

---

## Task 17: Release-Please

**Files:**

- Create: `.release-please-manifest.json`, `.release-please-config.json`, `.github/workflows/release-please.yml`
- Modify: `src-tauri/Cargo.toml` (add annotation)

- [ ] **Step 1: Create `.release-please-manifest.json`**

```json
{
  ".": "0.1.0"
}
```

- [ ] **Step 2: Create `.release-please-config.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "include-component-in-tag": false,
  "include-v-in-tag": true,
  "packages": {
    ".": {
      "extra-files": [
        {
          "type": "json",
          "path": "src-tauri/tauri.conf.json",
          "jsonpath": "$.version"
        },
        "src-tauri/Cargo.toml"
      ]
    }
  }
}
```

- [ ] **Step 3: Add annotation to `src-tauri/Cargo.toml`**

Find the `version = "0.1.0"` line in the `[package]` block. Append the release-please marker comment:

```toml
version = "0.1.0" # x-release-please-version
```

(Must be on the same line as `version = ...`. Release-please's generic file updater finds this annotation and rewrites the version on the same line.)

- [ ] **Step 4: Create `.github/workflows/release-please.yml`**

```yaml
name: Release Please

on:
  push:
    branches: [master]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: .release-please-config.json
          manifest-file: .release-please-manifest.json
```

---

## Task 18: E2E in CI

**Files:**

- Create: `.github/workflows/e2e.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/e2e.yml`**

```yaml
name: E2E Tests

on:
  workflow_call:
  workflow_dispatch:

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    name: Playwright (Chromium)
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 20.x
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Cache Playwright browsers
        id: pw-cache
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Install Playwright browsers
        if: steps.pw-cache.outputs.cache-hit != 'true'
        run: pnpm test:e2e:install

      - name: Run E2E tests
        run: pnpm test:e2e

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
```

- [ ] **Step 2: Read `.github/workflows/ci.yml`** to see how it dispatches existing jobs.

- [ ] **Step 3: Add e2e job dispatch** to `ci.yml`. Find the section where existing jobs (quality, test, build-tauri) are listed/called. Add a new job that calls `e2e.yml`:

```yaml
e2e:
  name: E2E
  needs: [quality, test] # adjust to match existing job names
  uses: ./.github/workflows/e2e.yml
```

(Adjust `needs:` to match the actual job names in your `ci.yml`. The intent: e2e runs only after quality and test gates pass.)

---

## Task 19: Update docs + final verification + Segment 4 commit

**Files:**

- Modify: `README.md`, `README_zh.md`, `CI_CD.md`

### Sub-Step 19a: README updates (English)

- [ ] **Step 1: Add new sections to `README.md`**

After the existing "Available Scripts" section, INSERT three new sections:

````markdown
## Internationalization (i18n)

The template ships with `next-intl` configured for **client-side locale switching** (no URL routing — Tauri webview has no public URLs):

- Locales: `en` (default) + `zh-CN`
- Translation files: `i18n/messages/en.json` + `i18n/messages/zh-CN.json`
- Use in components: `const t = useTranslations("namespace"); t("key")`
- Locale persistence: `localStorage` + cookie; falls back to `navigator.language`

To add a locale (e.g. `ja`):

1. Create `i18n/messages/ja.json` with the same structure
2. Add `"ja"` to the `locales` array in `i18n/config.ts`
3. Update `i18n/messages.ts` to import and register it

## Theming

`next-themes` provides light / dark / system theme switching:

- Default: follows system preference
- User toggle: stored in `localStorage` (`theme` key)
- CSS strategy: adds/removes `.dark` class on `<html>` (matches existing `globals.css` setup)
- See `components/theme-toggle.tsx` for the toggle component

## E2E Testing

Playwright tests run against the production static build (`pnpm build` → `out/`):

```bash
pnpm test:e2e         # run all E2E tests headlessly
pnpm test:e2e:ui      # open Playwright UI mode
pnpm test:e2e:install # download Chromium (run once after pnpm install)
```
````

Tests live in `e2e/`. The CI workflow (`.github/workflows/e2e.yml`) caches the browser binary between runs.

**Note:** E2E tests target the web build, not the Tauri desktop binary. UI code is shared, so passing here = passing in Tauri's webview. For desktop-specific E2E, see [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/).

````

- [ ] **Step 2: Update README's CI/CD section** (or add one if missing)

Add a subsection listing the 4 new CI capabilities + secrets table:

```markdown
### Continuous Integration

| Workflow | Trigger | Purpose | Required secrets |
|---|---|---|---|
| `ci.yml` | push, PR | Orchestrates quality + test + e2e | (none) |
| `quality.yml` | called by ci | ESLint + Prettier + typecheck | (none) |
| `test.yml` | called by ci | Jest + coverage upload | `CODECOV_TOKEN` (private repos only) |
| `e2e.yml` | called by ci | Playwright on built static export | (none) |
| `codeql.yml` | push, PR, weekly | Security analysis (JS/TS) | (none) |
| `release-please.yml` | push to master | Automated release PRs based on Conventional Commits | (none, uses GITHUB_TOKEN) |
| `build-tauri.yml` | called by ci | Cross-platform desktop builds | (optional code-signing secrets) |
````

### Sub-Step 19b: README_zh updates

- [ ] **Step 3: Apply equivalent sections to `README_zh.md`**

Translate the 3 new sections (Internationalization → 国际化, Theming → 主题, E2E Testing → 端到端测试) preserving code blocks and identifiers. Translate the CI/CD table caption and column headers.

### Sub-Step 19c: CI_CD.md update

- [ ] **Step 4: Edit `CI_CD.md`**

Find the existing "Workflows" section and add subsections for the 4 new workflows (codeql, release-please, e2e, plus the Codecov step in test.yml). For each, document:

- Trigger conditions
- Required secrets (most are none)
- How to disable / customize for forks

### Final verification

- [ ] **Step 5: Run all gates**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build 2>&1 | tail -3
```

Expected: all pass.

- [ ] **Step 6: Commit Segment 4**

```bash
git add codecov.yml .github/workflows/codeql.yml .github/workflows/release-please.yml .github/workflows/e2e.yml .release-please-manifest.json .release-please-config.json src-tauri/Cargo.toml .github/workflows/test.yml .github/workflows/ci.yml README.md README_zh.md CI_CD.md
git commit -m "ci: add Codecov + CodeQL + Release-Please + E2E workflow

- codecov.yml: 70% line target, ignore e2e/docs/mocks/src-tauri,
  default comment behavior
- test.yml: codecov-action@v5 step after pnpm test:coverage,
  resilient (continue-on-error, fail_ci_if_error: false) so
  tokenless public repos work and private repos without secret
  don't break
- codeql.yml: javascript-typescript analysis on push + PR + weekly
  schedule (Mondays 06:00 UTC); security-and-quality query suite;
  no secrets needed
- release-please.yml: triggered on push to master; manifest-driven
  config syncs version across package.json + tauri.conf.json
  (JSONPath) + Cargo.toml (x-release-please-version annotation).
  Coexists with manual release.yml as emergency channel.
- e2e.yml: Playwright job (Chromium on Ubuntu) with cached
  browsers; ci.yml dispatches it after quality + test pass;
  uploads playwright-report/ artifact on failure
- src-tauri/Cargo.toml: x-release-please-version annotation on
  version line for release-please to find
- README + README_zh: new Internationalization / Theming /
  E2E Testing sections; CI/CD subsection lists all 7 workflows
  with their secrets table
- CI_CD.md: synced with 4 new workflows + Codecov step"
```

---

# Final Validation Checklist

After Task 19, verify all spec acceptance criteria:

- [ ] `pnpm install` clean
- [ ] `pnpm dev` shows page with top-right LocaleSwitcher + ThemeToggle
- [ ] Click LocaleSwitcher → page text switches en ⇄ zh-CN; reload preserves choice
- [ ] Click ThemeToggle → `.dark` class on `<html>` toggles; reload preserves
- [ ] `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test` all green
- [ ] Test count: 33 (existing 25 + 4 use-locale + 2 locale-switcher + 2 theme-toggle)
- [ ] `pnpm test:e2e` — 4 tests pass in < 60s
- [ ] `pnpm tauri build` produces installer (i18n + theme work in Tauri webview)
- [ ] Optional manual: `pnpm tauri dev` — toggle locale + theme actually changes UI
- [ ] CI Codecov upload step is present in test.yml
- [ ] CodeQL workflow exists at .github/workflows/codeql.yml
- [ ] Release-Please config: manifest + config + workflow + Cargo.toml annotation all in place
- [ ] E2E workflow exists; ci.yml calls it
- [ ] README/README_zh have new i18n/theme/E2E sections + CI/CD table
- [ ] No stray uncommitted changes

---

# Risks & Mitigations

| Risk                                                                           | Mitigation (already in plan)                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `useTranslations()` called in Server Component without provider blows up build | Page becomes "use client"; layout uses LocaleProvider as innermost server-renderable wrapper |
| Existing 8 page tests break when page becomes client + uses translations       | jest.setup.ts global mock returns EN messages — assertions on English text continue to pass  |
| Theme toggle hydration mismatch                                                | `mounted` flag pattern from next-themes docs; placeholder span keeps button width stable     |
| Playwright build step times out in CI (3 minutes)                              | webServer.timeout = 180s (config); CI separately allots 15 min total                         |
| Release-Please first run wants to release everything since v0                  | Manifest pinned to current 0.1.0; first PR will offer next bump only                         |
| Cargo.toml annotation comment gets stripped by an auto-formatter               | rustfmt doesn't touch trailing comments by default; document this in CI_CD.md                |
| Codecov tokenless mode silent-fails for forks                                  | `continue-on-error: true` keeps CI green; coverage just doesn't upload                       |
