/**
 * ADR-0026 §3 §D — Phase 3 CSS-variables variant for plugin themes.
 *
 * Sanitizer-only tests; the full themes-bridge filesystem path needs Tauri
 * mocking and lives in `themes-bridge.test.ts`. These tests verify the
 * pure sanitization rules: only valid CSS custom property names pass,
 * values are length-capped and `</style>` is forbidden.
 */

import { __sanitizeCssVariablesForTesting } from "./themes-bridge"

describe("themes-bridge CSS-vars sanitizer", () => {
  it("accepts well-formed CSS custom properties", () => {
    const out = __sanitizeCssVariablesForTesting(
      { "--background": "#000", "--accent-1": "oklch(0.5 0.1 30)" },
      "p"
    )
    expect(out).toEqual({ "--background": "#000", "--accent-1": "oklch(0.5 0.1 30)" })
  })

  it("drops variable names that don't match the pattern", () => {
    const out = __sanitizeCssVariablesForTesting(
      {
        background: "#000", // no `--` prefix
        "--BAD": "x", // uppercase
        "--bad_name": "x", // underscore not allowed
        "--": "x", // empty after prefix
        "--ok": "#fff",
      },
      "p"
    )
    expect(out).toEqual({ "--ok": "#fff" })
  })

  it("drops empty strings and non-string values", () => {
    const out = __sanitizeCssVariablesForTesting(
      {
        "--a": "",
        "--b": 42 as unknown as string,
        "--c": "#fff",
      },
      "p"
    )
    expect(out).toEqual({ "--c": "#fff" })
  })

  it("drops values exceeding the length cap", () => {
    const tooLong = "a".repeat(300)
    const out = __sanitizeCssVariablesForTesting({ "--a": tooLong, "--b": "ok" }, "p")
    expect(out).toEqual({ "--b": "ok" })
  })

  it("drops values that try to break out via </style>", () => {
    const out = __sanitizeCssVariablesForTesting(
      { "--a": "red</style><script>alert(1)</script>", "--b": "#000" },
      "p"
    )
    expect(out).toEqual({ "--b": "#000" })
  })

  it("returns an empty object when every entry is invalid", () => {
    const out = __sanitizeCssVariablesForTesting({ bad: "x", "--BAD": "x" }, "p")
    expect(out).toEqual({})
  })
})
