-- Generic IMAP+SMTP mailbox connection (Gmail, Fastmail, etc.).
-- Singleton, parallel to outlook_oauth_connection. Picked at runtime
-- via OUTBOUND_MODE / INBOUND_MODE env switches.

CREATE TABLE "imap_smtp_connection" (
  "id"                    TEXT PRIMARY KEY,
  "mailboxAddress"        TEXT NOT NULL,
  "imapHost"              TEXT NOT NULL DEFAULT 'imap.gmail.com',
  "imapPort"              INTEGER NOT NULL DEFAULT 993,
  "smtpHost"              TEXT NOT NULL DEFAULT 'smtp.gmail.com',
  "smtpPort"              INTEGER NOT NULL DEFAULT 587,
  "appPasswordEncrypted"  BYTEA NOT NULL,
  "connectedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "connectedByUserId"     TEXT NOT NULL,
  "lastUsedAt"            TIMESTAMP(3)
);
