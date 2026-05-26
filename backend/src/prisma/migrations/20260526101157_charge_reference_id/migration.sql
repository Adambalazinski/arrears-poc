-- Human-readable upstream reference for chase emails.
-- LWCA's `referenceId` field (e.g. "#1Joj3F") is what tenants
-- recognise; the internal UUID is meaningless to them.

ALTER TABLE "charge"
  ADD COLUMN "lastKnownReferenceId" TEXT;
