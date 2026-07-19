/**
 * Browser E2E: standalone BYOK web-search contract.
 *
 * The Exa request is intercepted at its real HTTP boundary while answer
 * synthesis reaches the shared Anthropic mock from global setup. The mock's
 * unique echo marker proves the UI did not render a fixture disguised as a
 * model answer. Source navigation then opens a real target=_blank document.
 */

import { expect, test, type BrowserContext } from "@playwright/test"

import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"

const QUERY = "What changed in the E2E release?"
const SOURCE_URL = "https://docs.example.test/releases/e2e-governance"

function anthropicMockBaseUrl(): string {
  const url = process.env.E2E_ANTHROPIC_BASE_URL
  if (!url) {
    throw new Error(
      "E2E_ANTHROPIC_BASE_URL not published — global setup did not start the Anthropic mock"
    )
  }
  return url
}

async function installNetworkBoundaries(context: BrowserContext) {
  let exaRequest: { headers: Record<string, string>; body: unknown } | undefined

  await context.route("https://api.exa.ai/search", async (route) => {
    const request = route.request()
    exaRequest = {
      headers: request.headers(),
      body: request.postDataJSON(),
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "exa-e2e-request",
        resolvedSearchType: "neural",
        results: [
          {
            id: "release-notes",
            title: "Cognia E2E governance release notes",
            url: SOURCE_URL,
            score: 0.99,
            text: "The release added contract-based module coverage and a reviewed debt gate.",
          },
        ],
      }),
    })
  })

  await context.route(`${SOURCE_URL}*`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>E2E release notes</title><h1>E2E release notes</h1>",
    })
  })

  return () => exaRequest
}

test.describe("search — standalone cited answer", () => {
  test("searches through Exa, synthesizes an answer, and opens its source", async ({
    context,
    page,
  }) => {
    const getExaRequest = await installNetworkBoundaries(context)

    await page.goto("/")
    await resetCogniaDb(page)
    await setCogniaSettings(page, {
      defaultProvider: "anthropic",
      providerSettings: {
        anthropic: {
          enabled: true,
          apiKey: "test-e2e-key",
          baseURL: `${anthropicMockBaseUrl()}/v1`,
        },
      },
      searchMaxResults: 2,
      searchProviders: {
        exa: {
          providerId: "exa",
          apiKey: "exa-e2e-key",
          enabled: true,
          priority: 1,
        },
      },
    })

    await page.goto("/search", { waitUntil: "domcontentloaded" })
    const input = page.getByTestId("standalone-search-input")
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill(QUERY)
    await page.getByTestId("standalone-search-run").click()

    const answer = page.getByTestId("standalone-search-answer")
    await expect(answer).toContainText("[mock-anthropic-echo]", { timeout: 30_000 })
    await expect(answer).toContainText(QUERY)
    await expect(page.getByTestId("standalone-search-model-unavailable")).toHaveCount(0)

    expect(getExaRequest()).toMatchObject({
      headers: { "x-api-key": "exa-e2e-key" },
      body: {
        query: QUERY,
        numResults: 2,
        type: "auto",
        useAutoprompt: true,
      },
    })

    const sourceLink = page.getByRole("link", {
      name: /Cognia E2E governance release notes/,
    })
    await expect(sourceLink).toHaveAttribute("href", SOURCE_URL)
    const [sourcePage] = await Promise.all([context.waitForEvent("page"), sourceLink.click()])
    await expect(sourcePage).toHaveURL(SOURCE_URL)
    await expect(sourcePage.getByRole("heading", { name: "E2E release notes" })).toBeVisible()
    await sourcePage.close()
  })
})
