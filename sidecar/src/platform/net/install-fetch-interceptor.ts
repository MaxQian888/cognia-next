// Side-effect module: installs the fetch interceptor before anything that
// fetches. Host launchers import it first; the top-level await is the startup
// gate, so no module after it can load the SDK or issue a request until an
// enabled proxy is in place.

import { installFetchInterceptor } from "./fetch-interceptor.ts"

await installFetchInterceptor()
