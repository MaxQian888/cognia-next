import "./global.css"
import type { ReactNode } from "react"
import { RootProvider } from "fumadocs-ui/provider/next"

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
