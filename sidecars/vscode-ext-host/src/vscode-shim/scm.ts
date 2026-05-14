/**
 * `vscode.scm` — Tier 4. No SCM viewport in cognia.
 *
 * Extensions that need git data can still call `simple-git` via
 * `child_process` — the permission gate prompts the user.
 */

import { EventEmitter, NotSupportedError } from "./types"

export function createScmNamespace() {
  const dummy = new EventEmitter<unknown>()
  return {
    inputBox: {
      get value() {
        return ""
      },
      set value(_v: string) {
        throw new NotSupportedError("scm.inputBox")
      },
    },
    createSourceControl(_id: string, _label: string, _rootUri?: unknown): never {
      throw new NotSupportedError("scm.createSourceControl")
    },
    onDidChangeActiveSourceControl: dummy.event,
  }
}
