-- Explicit case-handler assignment. Nullable: when unset, the UI
-- falls back to the most-recent CaseEvent.actorUserId for "last
-- actioned by". HANDLER_ASSIGNED case events still record the
-- assignment + actor in the timeline; this column is just the
-- materialised current value for fast list-view rendering.

ALTER TABLE "case"
  ADD COLUMN "handlerUserId" TEXT;
