/**
 * `vscode.tests` — Tier 4. No test explorer in cognia.
 */

import { NotSupportedError } from "./types"

export function createTestsNamespace() {
  return {
    createTestController(_id: string, _label: string): never {
      throw new NotSupportedError("tests.createTestController")
    },
  }
}
