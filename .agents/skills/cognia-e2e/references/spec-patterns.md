# Cognia E2E spec patterns

These are decision patterns, not copy-ready code. Use current helper signatures and the closest live spec.

## Browser persistence journey

```typescript
import { expect, test } from "@playwright/test"
import { readDexieRow, resetCogniaDb } from "../helpers/db-reset"

test.beforeEach(async ({ page }) => {
  await page.goto("/")
  await resetCogniaDb(page)
})

test("persists the result after the user action", async ({ page }) => {
  await page.getByRole("button", { name: /verified accessible name/i }).click()
  await expect(page.getByRole("status")).toContainText(/observable result/i)
  expect(await readDexieRow(page, { table: "owningTable", key: "stable-key" })).toMatchObject({
    // owning persisted contract
  })
})
```

Use project helpers and app-owned test bridges. Do not import bundle aliases inside `page.evaluate`.

## Deterministic request contract

```typescript
test("sends the owned payload and renders the response", async ({ page }) => {
  const requestPromise = page.waitForRequest((request) => {
    return request.method() === "POST" && request.url().endsWith("/owned-route")
  })

  await page.getByRole("button", { name: /submit/i }).click()
  const request = await requestPromise

  expect(request.postDataJSON()).toMatchObject({ /* stable public fields */ })
  await expect(page.getByRole("status")).toHaveText(/completed/i)
})
```

Prefer an existing mock server when the route participates in global setup.

## Mobile boot

```typescript
import { test } from "@playwright/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test("completes the mobile journey", async ({ page }) => {
  await injectCapacitor(page, { /* current helper options */ })
  await page.goto("/")
  await bootstrapCogniaMobile(page, "standalone")
  // user action and observable result
})
```

Verify actual helper names and call order from current mobile specs.

## Tauri native contract

```typescript
import { expect, test } from "../fixtures"

test("crosses the native boundary and renders the result", async ({ page }) => {
  // arrange native/mock control state through the existing fixture
  // perform the user action
  await expect(page.getByRole("status")).toHaveText(/stable result/i)
  // assert native/IPC diagnostic when it is the ownership reason
})
```

Never import bare `@playwright/test` when the local Tauri fixture owns page/context.

## Selector and wait order

Prefer:

1. `getByRole(..., { name })`
2. stable visible text
3. semantic `getByTestId`
4. minimal CSS only when no accessible or test seam exists

Wait for UI state, request, persistent row, public event, mock control state, or native diagnostic.

## Forbidden patterns

```typescript
await page.waitForTimeout(5000) // guesses readiness
expect(true).toBe(true) // vacuous
test.skip(true, "later") // ungoverned permanent debt
```

If the contract cannot run, record a blocked gap or add a precise, reviewed, time-bounded governance exception when repository policy authorizes it.
