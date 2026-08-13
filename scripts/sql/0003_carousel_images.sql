-- Friday Stairs — homepage carousel image manager.
-- A public Supabase Storage bucket holds the photos; this table holds their
-- display order. The homepage fetches the ordered list and rotates through it;
-- the /dashboard uploads/deletes/reorders.
--
-- NOTE: currently hosted in the "MetabolicHealth" Supabase project as a
-- temporary home (see PARTNER_STATS_SUPABASE_* in .env). This migration exists
-- so it can be recreated in a dedicated Friday Stairs project later. The bucket
-- name and table are namespaced to stay isolated wherever they live.

insert into storage.buckets (id, name, public)
values ('friday-stairs-carousel', 'friday-stairs-carousel', true)
on conflict (id) do update set public = true;

create table if not exists public.friday_stairs_carousel_images (
  id           uuid primary key default gen_random_uuid(),
  position     integer not null default 0,   -- 1..N display order
  storage_path text not null,                -- path within the bucket
  created_at   timestamptz not null default now()
);

alter table public.friday_stairs_carousel_images enable row level security;

-- Public read (the homepage lists images); writes go through the site server
-- (anon key) gated by the /dashboard password at the app layer.
drop policy if exists fs_carousel_public_read on public.friday_stairs_carousel_images;
create policy fs_carousel_public_read
  on public.friday_stairs_carousel_images for select to anon using (true);
drop policy if exists fs_carousel_anon_write on public.friday_stairs_carousel_images;
create policy fs_carousel_anon_write
  on public.friday_stairs_carousel_images for all to anon using (true) with check (true);

-- Storage object policies scoped to this bucket (anon read/insert/delete).
drop policy if exists fs_carousel_obj_read on storage.objects;
create policy fs_carousel_obj_read
  on storage.objects for select to anon using (bucket_id = 'friday-stairs-carousel');
drop policy if exists fs_carousel_obj_insert on storage.objects;
create policy fs_carousel_obj_insert
  on storage.objects for insert to anon with check (bucket_id = 'friday-stairs-carousel');
drop policy if exists fs_carousel_obj_delete on storage.objects;
create policy fs_carousel_obj_delete
  on storage.objects for delete to anon using (bucket_id = 'friday-stairs-carousel');
