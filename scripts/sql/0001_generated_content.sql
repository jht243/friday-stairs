-- Friday Stairs — generated-content memory / dedup table.
-- One row per piece of generated content, across ALL section types.
-- Lifecycle: status starts 'generated', flips to 'skipped' (never reuse) or
-- 'submitted' (went out in an email — never reuse).
-- Uniqueness guard is enforced in app code by checking title_norm + fingerprint
-- before insert; this keeps prompts bounded (history is NOT fed into the prompt).

create table if not exists public.generated_content (
  id          uuid primary key default gen_random_uuid(),
  section_type text not null,            -- recipe | news-blurb | workout-tip | playlist | weekly-recap | message-of-week
  title        text not null default '',
  title_norm   text not null default '', -- lowercased/collapsed title for case-insensitive dedup
  markdown     text not null default '',
  fingerprint  text not null,            -- sha256 of normalized content — catches "exact same workout"
  source_url   text,                     -- recipes/news source (null for fully-generated sections)
  status       text not null default 'generated'
                 check (status in ('generated','skipped','submitted')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gc_type_status      on public.generated_content (section_type, status);
create index if not exists idx_gc_type_titlenorm    on public.generated_content (section_type, title_norm);
create index if not exists idx_gc_type_fingerprint  on public.generated_content (section_type, fingerprint);

-- RLS on; only the server (service/secret key) touches this table, and the
-- service role bypasses RLS, so no anon policies are defined on purpose.
alter table public.generated_content enable row level security;
