export function isUnifiedTemplatePlatformEnabled(
  value = process.env.NEXT_PUBLIC_UNIFIED_TEMPLATE_PLATFORM
): boolean {
  return value !== "0" && value !== "false"
}
