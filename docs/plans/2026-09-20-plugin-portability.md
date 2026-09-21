# Plugin portability implementation

Authorized on 2026-09-20 after discussion of native export and Cognia-hosted tools.

The public verification seams are bundle conversion, source-bound inspect/apply,
skill registry activation, native package normalization/projection, and the
conversion dialog. The working tree already contains unrelated changes; keep
them intact. A pre-edit snapshot of conversion files is held outside the repo.

1. Fix silent source loss, invocation policy, resource closure and credentials.
   Verify with minimal failing bundle fixtures and skill runtime tests.
2. Normalize and project supported platform declarations, with explicit blockers
   for incompatible runtime, policy, hook and scope semantics. Verify native
   schemas and package paths against official documentation and fixture tests.
3. Share target and delivery information across inspect/apply, CLI and UI.
   Native output is standalone; hosted tools require an enabled Cognia plugin
   and a live Cognia session. UI, bot lifecycle and other host contributions
   remain in Cognia. Static analysis never claims live-host certification.
4. Provide review-before-write in the existing plugin panel. Bind writes to the
   inspected source, target and surface; reject stale or concurrently used plans.
5. Run focused tests, typecheck, i18n checks and UI verification. Coverage checks
   are skipped at the user's explicit request on 2026-09-20. Report unrelated or
   environmental failures separately from scoped validation.

No native plugin install is implied by writing a converted package. Native-host
acceptance requires a compatible installed version and actual runtime checks.

Verification on 2026-09-20: 27 focused Jest suites / 1,020 tests passed; Rust CLI
import tests passed 14 / 14; six bundle-builder tests passed, including standalone
filesystem import/export with binary resources and dotenv sanitization. Scoped
ESLint and diff checks passed. Generated translations, the built-in skill body,
the embedded converter and SDK author types were rebuilt. The standalone check
also caught and fixed jsonc-parser's unbundled UMD imports.

Full typecheck still reports unrelated errors in
`lib/router-fusion/runtime/delegate-host-ports.test.ts`. The global i18n lint
reports missing `chat.empty.characterEntry` in the unrelated desktop workspace.
The local application server was unavailable, so real UI verification and native
agent installation/runtime acceptance remain unverified. Coverage was skipped.
