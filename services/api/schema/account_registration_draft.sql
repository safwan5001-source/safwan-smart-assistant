-- Review-only additive draft; not applied to production.
-- Existing phase5_draft.sql creates accounts without display_name.
ALTER TABLE accounts ADD COLUMN display_name text NOT NULL DEFAULT '';
-- Before release, validate real migration strategy for existing accounts and
-- enforce length, blank-name and email uniqueness semantics at service boundary.
