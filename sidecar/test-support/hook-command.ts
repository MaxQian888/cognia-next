// Keep quoting compatible with both cmd.exe and POSIX sh.
export const nodeCmd = (js: string) => `node -e "${js}"`
