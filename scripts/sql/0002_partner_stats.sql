-- Friday Stairs — Partner page stats micro-CMS.
-- Four editable stats shown in the stats bar on partnership.html.
-- The team edits these via the password-protected /partner-admin editor;
-- the server injects the current values when it serves the Partner page.
-- Seeding is idempotent (on conflict do nothing) so re-running migrations
-- NEVER overwrites values the team has edited.
--
-- NOTE: this is currently hosted in the "MetabolicHealth" Supabase project as a
-- temporary home (see PARTNER_STATS_SUPABASE_* in .env). This migration exists
-- so the table can be recreated in a dedicated Friday Stairs project later.
-- The table name is namespaced to stay isolated wherever it lives.

create table if not exists public.friday_stairs_partner_stats (
  position   integer primary key,   -- 1..4, controls display order
  value      text not null,         -- the big number, e.g. "70%", "879K+"
  label      text not null,         -- the caption under the number
  updated_at timestamptz not null default now()
);

insert into public.friday_stairs_partner_stats (position, value, label) values
  (1, '70%',   'Average Newsletter Open Rate'),
  (2, '29%',   'Average Click-to-Open Rate — top 5% of newsletters on beehiiv'),
  (3, '71K+',  'People Reached Monthly Across Digital Channels'),
  (4, '879K+', 'Monthly Content Views on Social Platforms')
on conflict (position) do nothing;

-- Public read is fine (these stats are shown publicly on the site).
-- Writes go only through the site server using the service_role key, which
-- bypasses RLS, so no anon write policy is defined on purpose.
alter table public.friday_stairs_partner_stats enable row level security;
drop policy if exists fs_partner_stats_public_read on public.friday_stairs_partner_stats;
create policy fs_partner_stats_public_read
  on public.friday_stairs_partner_stats
  for select to anon using (true);
