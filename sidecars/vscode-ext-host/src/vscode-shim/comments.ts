/**
 * `vscode.comments` — Tier 4. No PR review viewport in cognia.
 */

import { NotSupportedError } from "./types"

export function createCommentsNamespace() {
  return {
    createCommentController(_id: string, _label: string): never {
      throw new NotSupportedError("comments.createCommentController")
    },
  }
}
