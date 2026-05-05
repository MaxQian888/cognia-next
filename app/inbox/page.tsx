/**
 * /inbox — redirect to /inbox/all.
 *
 * This is a Next.js 16 server component; it runs on the server (or at
 * build time for static export) so `redirect()` from `next/navigation` is
 * the correct API here.
 */
import { redirect } from "next/navigation"

export default function InboxPage() {
  redirect("/inbox/all")
}
