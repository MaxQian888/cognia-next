/** @jest-environment node */

import { getContextWorkbenchWindowScope } from "./use-context-workbench-instance-id"

it("uses a deterministic server scope without accessing browser storage", () => {
  expect(getContextWorkbenchWindowScope()).toBe("server")
})
