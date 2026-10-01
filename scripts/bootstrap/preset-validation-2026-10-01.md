# Preset and native runtime validation — 2026-10-01

The final authenticated acceptance run passed **14/14 checks** on macOS ARM,
using independently copied Bash and PowerShell scripts. The provider was
`https://api.deepseek.com`, model `deepseek-flash`, with streamed responses.
Credentials came from `DEEPSEEK_API_KEY`; no credential values were written to
configurations or retained artifacts. The harness scanned its artifacts for the
exact key after completion.

## Final source identity

| Runtime    | SHA-256                                                            |
| ---------- | ------------------------------------------------------------------ |
| Bash       | `6096485f5efcf46b3abc8a0c9b96e0136318559b8a4cb2c1a7606b3410eace66` |
| PowerShell | `ad65cbb1e0b91c87bbad3b1ca60ac6aa1433db8b177dffbcc325c2112568c85a` |

## Authenticated and real package-manager acceptance

Times are one-run wall-clock measurements, not a performance benchmark.

| Check                                  |   Bash | PowerShell | Evidence                                                                                                            |
| -------------------------------------- | -----: | ---------: | ------------------------------------------------------------------------------------------------------------------- |
| Provider + coding preset configuration | 0.24 s |     0.82 s | Correct endpoint, model and credential reference; copied scripts need no sibling catalog                            |
| Offline doctor                         | 0.21 s |     0.42 s | Healthy report without a model request                                                                              |
| Authenticated model discovery          | 0.65 s |     0.71 s | Real GET response includes `deepseek-flash`                                                                         |
| Real model tools and verification      | 9.56 s |     7.23 s | Four model steps each; editor reads `3/5/8`, writes exact two-byte `16`, shell verifies with `od -c` / `Format-Hex` |
| Chat preset and model switching        | 1.51 s |     1.51 s | `/status`, `/model deepseek-flash`, real response `PRESET_CHAT_OK`                                                  |
| pnpm recipe initialization             | 1.85 s |     1.37 s | Actual locked install of a local fixture package; readiness passes, zero model steps, API key absent                |
| Recipe reuse                           | 1.22 s |     0.72 s | Fresh checks pass, `reused=true`, zero model steps, API key absent                                                  |

The pnpm fixture used a local `file:` dependency to exercise installation and
`node_modules` creation without relying on a package-registry download. Other
recipes are covered by configuration/command assertions, not live package-manager
installation claims.

## Defects reproduced and repaired during acceptance

1. Bash `/models` counted time spent waiting at the chat prompt against the request
   budget. A delayed-input regression failed first; budgets now begin after input.
2. Bash model discovery accepted whitespace-only and oversized IDs that its model
   configuration rejected. Discovery now uses the same nonempty/byte limits.
3. PowerShell accepted bare `--stream` but rejected Bash's `--stream true|false`
   syntax. Both explicit booleans now work, preserving PowerShell's existing flags.
4. JSON newline syntax before an `od` offset produced `\n0000002`, whose `n0000002`
   substring matched the passport rule. JSON syntax is now distinguished from
   decoded content. Raw values, nested values/keys, readiness output, numeric
   sensitive fields and exact environment secrets remain checked recursively.
5. PowerShell `Format-Hex` emits a sixteen-zero offset. Its zero Luhn checksum
   caused a card-number false positive, reproduced with an actual DeepSeek tool
   call. All-zero candidates are excluded from the Luhn-only heuristic; valid
   nonzero Luhn candidates and exact known secrets remain blocked.

The final live task explicitly invokes both affected verification commands and
passes. The older unretained privacy block in
[the previous report](live-validation-2026-10-01.md) cannot be conclusively
attributed to either newly reproduced cause.

## Cognia integration and browser evidence

Final native process suites passed: Bash **67/67** (50 shared + 17 specific),
PowerShell **50/50 shared + 10/10 specific**. They exercise the real scripts with
a local HTTP fixture and child shells; they are distinct from the authenticated
provider acceptance above. Bash's full suite took 156.013 s; PowerShell's shared
suite took 93.191 s and its specific suite took 18.415 s.

Seven focused environment/helper/component/database suites passed **202 tests**.
The provider, task and recipe controls were also exercised in a real browser
using an isolated harness that mounts the production component, helpers, UI
primitives and English messages. Applying a provider cleared stale auth/headers
while preserving a custom script path; applying Chat disabled workspace tools;
applying a recipe updated setup, checks, reuse and budgets together.

This is component browser acceptance, not the complete desktop environment
creation/save/launch path. The harness excludes an unused native bridge barrel
re-export so it can bundle outside Next.js; parent persistence is tested by Jest.
Windows/Linux execution and authentication to the other provider presets were
not performed in this session.

Scoped ESLint, Prettier, Bash syntax/ShellCheck, translation catalog freshness,
ICU validation, sorting and the final repository-wide i18n lint passed. No
missing keys were found in the 69 checked Bootstrap translation references.
Full TypeScript checking remains blocked by unrelated Lark/workflow/wallpaper
diagnostics; no diagnostics were reported in the changed preset files.

## Local evidence locations

- Final scripts, configurations, output logs, fixture installations and JSON report:
  `/var/folders/h3/mypbg9ks5cj9ht4p61ffnwz40000gn/T/cognia-presets-verified-live-uarln1mv/`
- Masked JSON/passport diagnosis:
  `/var/folders/h3/mypbg9ks5cj9ht4p61ffnwz40000gn/T/cognia-privacy-diagnostic-jjd6u1ng/`
- Masked pre-fix real Format-Hex diagnosis:
  `/var/folders/h3/mypbg9ks5cj9ht4p61ffnwz40000gn/T/cognia-ps-hex-diagnostic-brhfy4eg/`
- Browser component harness and screenshot:
  `/var/folders/h3/mypbg9ks5cj9ht4p61ffnwz40000gn/T/cognia-preset-ui-a5myla7x/`

Temporary evidence can expire. Durable regression cases live in
`standalone.test.py`, `bash-runtime.test.py`, `powershell-runtime.test.py`, and
the co-located Cognia tests.
