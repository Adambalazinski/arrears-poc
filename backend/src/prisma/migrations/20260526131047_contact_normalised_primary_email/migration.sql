-- Indexed normalised primaryEmail for inbound sender matching.
-- Strips plus-addressing (local+tag@host -> local@host) and lowercases
-- so the matcher can resolve a reply from "user@host" back to a stored
-- contact with "user+tag@host".

ALTER TABLE "contact"
  ADD COLUMN "normalisedPrimaryEmail" TEXT;

-- Backfill from existing rows. SQL mirror of InboundSenderMatcher.normaliseEmail
-- in TS: lowercase the whole address, then strip everything between
-- "+" and "@" in the local part.
UPDATE "contact"
SET "normalisedPrimaryEmail" = regexp_replace(
  lower("primaryEmail"),
  '\+[^@]*@',
  '@'
)
WHERE "primaryEmail" IS NOT NULL;

CREATE INDEX "contact_normalisedPrimaryEmail_idx"
  ON "contact" ("normalisedPrimaryEmail");
