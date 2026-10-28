-- PowerGIS: a readable summary of each workspace, next to its document.
-- Run once in the Supabase SQL editor, after 002_delete_account.sql.
--
-- The app rewrites it on every save (lib/workspace/file.ts overviewOf): one
-- line per dataset, transform and visualization. Nothing reads it back to
-- open a workspace; it's for people (and listing workspaces later).
alter table public.workspaces add column overview text not null default '';
