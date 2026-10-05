/** A key-echoing `useTranslations` for the account sync component tests (not shipped). */

export function echoTranslations() {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key
  t.has = () => true
  return t
}
