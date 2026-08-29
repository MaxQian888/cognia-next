/**
 * Redaction for the Playwright fixture's captured console, page errors, and
 * network log.
 *
 * The patterns themselves live in `lib/security/redact-credentials.ts` — Sites
 * build logs persist process output and need exactly the same four — so this
 * module is now the e2e-named face of one implementation.
 */
export {
  redactCredentialText as redactE2EDiagnosticText,
  redactCredentialUrl as redactE2EDiagnosticUrl,
  SENSITIVE_QUERY_KEYS,
} from "@/lib/security/redact-credentials"
