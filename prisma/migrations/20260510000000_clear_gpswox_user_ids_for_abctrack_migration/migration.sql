-- Stale GPSWOX user_id values are meaningless against Abctrack — clear them
-- so the email-based auto-mapper repopulates each Client.gpswoxUserId on the
-- next webhook (or the next operator-triggered manual sync).
--
-- Status reset rationale: any Client whose mapping just disappeared cannot
-- meaningfully be ACTIVE/BLOCKED until the new mapping lands. Demoting them
-- to UNKNOWN forces the auto-match path to re-evaluate and surface
-- NO_MATCHING_GPSWOX_USER for any account that doesn't exist on Abctrack.
-- CANCELLED rows stay CANCELLED — that's a terminal state.
UPDATE "clients"
SET "gpswoxUserId" = NULL,
    "status" = CASE
      WHEN "status" = 'CANCELLED'::"ClientStatus" THEN 'CANCELLED'::"ClientStatus"
      ELSE 'UNKNOWN'::"ClientStatus"
    END
WHERE "gpswoxUserId" IS NOT NULL;
