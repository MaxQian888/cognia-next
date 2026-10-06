/** Loaded before all configured Pi extensions to own the first-result user_bash hook. */
import { registerUserBashGuard } from "./cognia-pi-extension.ts"

export default registerUserBashGuard
