/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// FeaturePageShell uses `useIsMobile()` which calls `matchMedia` — jsdom
// doesn't ship a `matchMedia` implementation, so stub the hook to return
// the desktop branch unconditionally for this smoke test.
jest.mock("@/hooks/ui", () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
  useIsNarrow: () => false,
  useBreakpoint: () => "desktop",
}))

const mockRows: PluginRow[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows)),
  setPluginEnabled: jest.fn(),
  deletePlugin: jest.fn(),
  getPlugin: jest.fn(() => Promise.resolve(undefined)),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
    },
    pluginPermissions: {
      where: () => ({ equals: () => ({ delete: async () => undefined }) }),
    },
  }),
}))

import PluginsRoutePage from "./page"

describe("PluginsRoutePage", () => {
  it("renders the PluginPanel's 3-pane shell inside the page container", () => {
    const { container } = render(<PluginsRoutePage />)
    expect(container.querySelector("[data-bg-target='chat']")).toBeInTheDocument()
    // The 3-pane shell renders the left-nav library section button as a
    // stable affordance of the new layout.
    expect(screen.getByTestId("plugin-nav-library")).toBeInTheDocument()
  })
})
