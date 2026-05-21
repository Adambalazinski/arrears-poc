-- Add LWCA invoice.type + invoice.description to Charge so the UI
-- can surface them on the charges table. Both nullable because
-- (a) fixtures and (b) some stage invoices don't set description.

ALTER TABLE "charge"
  ADD COLUMN "lastKnownType"        TEXT,
  ADD COLUMN "lastKnownDescription" TEXT;
