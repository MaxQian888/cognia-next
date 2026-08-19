/** @jest-environment jsdom */

import { loadPostHogBrowser } from "./posthog-loader"

jest.mock("posthog-js/dist/module.slim.js", () => ({
  __esModule: true,
  default: { init: jest.fn() },
}))

it("loads the pinned slim browser client lazily", async () => {
  const client = await loadPostHogBrowser()
  expect(typeof client.init).toBe("function")
})
