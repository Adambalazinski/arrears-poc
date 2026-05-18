-- CreateEnum
CREATE TYPE "OrphanInboundReason" AS ENUM ('UNMATCHED_SENDER', 'AMBIGUOUS_SENDER');

-- CreateTable
CREATE TABLE "outlook_poll_cursor" (
    "id" TEXT NOT NULL,
    "lastReceivedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlook_poll_cursor_pkey" PRIMARY KEY ("id")
);

-- Singleton enforcement: only one row, always keyed 'singleton'.
ALTER TABLE "outlook_poll_cursor"
  ADD CONSTRAINT "outlook_poll_cursor_singleton_chk"
  CHECK (id = 'singleton');

-- CreateTable
CREATE TABLE "orphan_inbound" (
    "id" TEXT NOT NULL,
    "outlookMessageId" TEXT NOT NULL,
    "reasonKind" "OrphanInboundReason" NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "rawBodyText" TEXT,
    "matchedContactsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orphan_inbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orphan_inbound_outlookMessageId_key" ON "orphan_inbound"("outlookMessageId");

-- CreateIndex
CREATE INDEX "orphan_inbound_reasonKind_createdAt_idx" ON "orphan_inbound"("reasonKind", "createdAt");
