-- The Cognia apps as OAuth clients (ADR-0215 §2; src/first-party-clients.ts).
--
-- Hand-written: Better Auth has no session-less way to create a client, and
-- client management is closed over HTTP. Both clients are public (PKCE, no
-- secret), skip the consent screen because they are first-party, and are
-- owned by nobody: an owner's deletion would cascade to the client.
--
-- The sync resource row exists here so the link rows can reference it; the
-- Worker rewrites its settings from configuration at startup
-- (resourceSeedMode "overwrite"). `cognia-web`'s redirect URIs are likewise
-- reconciled from WEB_ORIGINS at runtime; the value below is production's.

INSERT INTO "oauthResource" (
  "id", "identifier", "name", "accessTokenTtl", "allowedScopes",
  "dpopBoundAccessTokensRequired", "disabled", "createdAt", "updatedAt", "policyVersion"
) VALUES (
  'res_cognia_sync', 'https://sync.cognia.cn', 'Cognia sync', 900,
  '["openid","profile","email","offline_access"]',
  0, 0, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', 1
);

-- Desktop, phone and CLI. Loopback redirects match on any port (RFC 8252 §7.3).
INSERT INTO "oauthClient" (
  "id", "clientId", "clientSecret", "disabled", "skipConsent", "enableEndSession",
  "subjectType", "scopes", "clientCredentialsScopes", "userId", "createdAt", "updatedAt",
  "name", "uri", "redirectUris", "postLogoutRedirectUris", "tokenEndpointAuthMethod",
  "applicationType", "grantTypes", "responseTypes", "requirePKCE", "dpopBoundAccessTokens"
) VALUES (
  'oc_cognia_app', 'cognia-app', NULL, 0, 1, 1,
  'public', '["openid","profile","email","offline_access"]', '[]', NULL,
  '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z',
  'Cognia', 'https://cognia.cn',
  '["cn.cognia.app:/auth/callback","http://127.0.0.1/callback"]', '[]', 'none',
  'native', '["authorization_code","refresh_token"]', '["code"]', 1, 0
);

-- The official web app (a browser SPA).
INSERT INTO "oauthClient" (
  "id", "clientId", "clientSecret", "disabled", "skipConsent", "enableEndSession",
  "subjectType", "scopes", "clientCredentialsScopes", "userId", "createdAt", "updatedAt",
  "name", "uri", "redirectUris", "postLogoutRedirectUris", "tokenEndpointAuthMethod",
  "applicationType", "grantTypes", "responseTypes", "requirePKCE", "dpopBoundAccessTokens"
) VALUES (
  'oc_cognia_web', 'cognia-web', NULL, 0, 1, 1,
  'public', '["openid","profile","email","offline_access"]', '[]', NULL,
  '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z',
  'Cognia', 'https://cognia.cn',
  '["https://app.cognia.cn/logto/callback"]', '["https://app.cognia.cn/"]', 'none',
  'web', '["authorization_code","refresh_token"]', '["code"]', 1, 0
);

INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt") VALUES
  ('ocr_cognia_app_sync', 'cognia-app', 'https://sync.cognia.cn', '2026-10-05T00:00:00.000Z'),
  ('ocr_cognia_web_sync', 'cognia-web', 'https://sync.cognia.cn', '2026-10-05T00:00:00.000Z');
