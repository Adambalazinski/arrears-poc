-- Singleton table for the app-wide delegated-OAuth Outlook connection.
-- Only one row is ever created (id="default"); the OutlookOAuthService
-- upserts on that key.

CREATE TABLE "outlook_oauth_connection" (
  "id"                     TEXT PRIMARY KEY,
  "tenantId"               TEXT NOT NULL,
  "mailboxUpn"             TEXT NOT NULL,
  "scope"                  TEXT NOT NULL,
  "refreshTokenEncrypted"  BYTEA NOT NULL,
  "accessTokenEncrypted"   BYTEA,
  "accessTokenExpiresAt"   TIMESTAMP(3),
  "lastRefreshedAt"        TIMESTAMP(3),
  "connectedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "connectedByUserId"      TEXT NOT NULL
);
