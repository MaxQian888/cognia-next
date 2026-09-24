import { BUILT_IN_VSCODE_THEMES } from "../lib/appearance/built-in-vscode-themes"
for (const t of BUILT_IN_VSCODE_THEMES) {
  const v = t.baseVariant === "dark" ? "dark" : "light"
  console.log("##", t.name, "base:", v)
  const c = t.tokens![v]
  for (const k of ["background","foreground","primary","primaryForeground","secondary","secondaryForeground","accent","accentForeground","muted","mutedForeground","card","popover","input","border","ring","destructive","sidebar","sidebarForeground","sidebarAccent"]) {
    console.log(`  ${k}: ${(c as Record<string,string>)[k]}`)
  }
}
