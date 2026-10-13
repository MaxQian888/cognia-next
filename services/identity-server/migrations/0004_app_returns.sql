-- App returns (src/app-return.ts): a phone sign-in that ran in another app
-- (the Feishu app's WebView) can be finished by the Cognia app itself when
-- that app will not open cn.cognia.app:/auth/callback.
--
-- One row per native authorize request, keyed by a hash of its `state`. The
-- PKCE challenge is recorded when the request arrives; the code is attached
-- when the issuer redirects it back to the app; a claim that proves the
-- verifier takes the code once and deletes the row. Short-lived by design.
CREATE TABLE "app_return" (
  "state_hash" TEXT NOT NULL PRIMARY KEY,
  "code_challenge" TEXT NOT NULL,
  "code" TEXT,
  "expires_at" INTEGER NOT NULL
);

CREATE INDEX "app_return_expires_idx" ON "app_return" ("expires_at");
