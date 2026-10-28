-- PowerGIS: the Supabase schema (accounts, cloud datasets, sharing, workspaces).
-- Run once in the Supabase SQL editor. Later changes go in new files next to
-- this one, never edits to it, so the database and the repo stay in step.
--
-- Trust model: the publishable key ships in the app, so every rule lives here.
-- Row-level security on every table; the app's role ("authenticated") gets only
-- the grants below. A dataset's rows are a Parquet file in the private
-- "datasets" bucket at <dataset id>/data.parquet, guarded by the same access table.

-- ── people ──────────────────────────────────────────────────────────────────
-- One row per signed-in user, made when they sign up. auth.users isn't
-- readable from the app, so names and emails live here.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), split_part(coalesce(new.email, ''), '@', 1));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── datasets ────────────────────────────────────────────────────────────────
-- The registry: what each dataset is. Its rows are the Parquet file.
create table public.datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  columns jsonb not null default '[]',   -- [{name, type}, …]
  row_count bigint not null default 0,
  meta jsonb not null default '{}',      -- origin, extensions, profile
  file_path text,                        -- <id>/data.parquet once uploaded
  size_bytes bigint,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Who may do what with a dataset. owner: everything, one per dataset, made
-- with the dataset. write: change it, and share it (read or write). read: see it.
create table public.dataset_access (
  dataset_id uuid not null references public.datasets (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  access text not null check (access in ('owner', 'write', 'read')),
  granted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (dataset_id, user_id)
);
create unique index dataset_access_one_owner on public.dataset_access (dataset_id) where access = 'owner';
create index dataset_access_by_user on public.dataset_access (user_id);

-- The caller's access to a dataset (null = none). Security definer so the
-- policies on dataset_access can use it without checking themselves forever.
create function public.access_level(ds uuid) returns text
language sql stable security definer set search_path = '' as $$
  select a.access from public.dataset_access a
  where a.dataset_id = ds and a.user_id = auth.uid()
$$;

-- The same, by a storage folder name (text, so a stray name can't fail a cast).
create function public.access_level_for_folder(folder text) returns text
language sql stable security definer set search_path = '' as $$
  select a.access from public.dataset_access a
  where a.dataset_id::text = folder and a.user_id = auth.uid()
$$;

-- Whoever makes a dataset owns it.
create function public.own_new_dataset() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dataset_access (dataset_id, user_id, access, granted_by)
  values (new.id, auth.uid(), 'owner', auth.uid());
  return new;
end $$;

create trigger on_dataset_created
  after insert on public.datasets
  for each row execute function public.own_new_dataset();

-- ── workspaces ──────────────────────────────────────────────────────────────
-- A user's workspaces; config is the same JSON as a .powergis.json file
-- (dataset pointers, transforms, visualizations). One default per user.
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  name text not null default 'My workspace',
  config jsonb not null default '{}',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index workspaces_one_default on public.workspaces (owner_id) where is_default;

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger datasets_touch before update on public.datasets
  for each row execute function public.touch_updated_at();
create trigger workspaces_touch before update on public.workspaces
  for each row execute function public.touch_updated_at();

-- ── row-level security ──────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.datasets enable row level security;
alter table public.dataset_access enable row level security;
alter table public.workspaces enable row level security;

create policy "own profile" on public.profiles
  for select using (id = auth.uid());
create policy "edit own profile" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- (created_by too: an insert's returned row is checked before the owner row exists)
create policy "see shared datasets" on public.datasets
  for select using (created_by = auth.uid() or public.access_level(id) is not null);
create policy "make datasets" on public.datasets
  for insert with check (created_by = auth.uid());
create policy "writers change datasets" on public.datasets
  for update using (public.access_level(id) in ('owner', 'write'));
create policy "owners delete datasets" on public.datasets
  for delete using (public.access_level(id) = 'owner');

-- Members see who else has access.
create policy "members see access" on public.dataset_access
  for select using (user_id = auth.uid() or public.access_level(dataset_id) is not null);
-- Owners and writers grant read or write (the owner row only comes from the trigger).
create policy "writers grant" on public.dataset_access
  for insert with check (
    access in ('read', 'write')
    and granted_by = auth.uid()
    and public.access_level(dataset_id) in ('owner', 'write')
  );
-- Owners change anyone's level; writers only raise read to write.
create policy "change levels" on public.dataset_access
  for update using (
    access <> 'owner'
    and (public.access_level(dataset_id) = 'owner'
         or (public.access_level(dataset_id) = 'write' and access = 'read'))
  ) with check (access in ('read', 'write'));
-- Owners remove anyone; writers remove readers; anyone but the owner can leave.
create policy "remove access" on public.dataset_access
  for delete using (
    access <> 'owner'
    and (public.access_level(dataset_id) = 'owner'
         or (public.access_level(dataset_id) = 'write' and access = 'read')
         or user_id = auth.uid())
  );

create policy "own workspaces" on public.workspaces
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ── lookups for sharing ─────────────────────────────────────────────────────
-- Find one person by exact email (to share with them), without exposing the
-- list of everyone.
create function public.find_user_by_email(lookup text)
returns table (id uuid, email text, display_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.email, p.display_name from public.profiles p
  where auth.uid() is not null and lower(p.email) = lower(trim(lookup))
$$;

-- Everyone with access to a dataset the caller can see.
create function public.dataset_members(ds uuid)
returns table (user_id uuid, email text, display_name text, access text)
language sql stable security definer set search_path = '' as $$
  select a.user_id, p.email, p.display_name, a.access
  from public.dataset_access a join public.profiles p on p.id = a.user_id
  where a.dataset_id = ds and public.access_level(ds) is not null
$$;

-- ── what the app may touch ──────────────────────────────────────────────────
-- New tables aren't exposed automatically on this project; grant exactly this.
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.datasets to authenticated;
grant select, insert, update, delete on public.dataset_access to authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;

revoke execute on function public.access_level(uuid) from public, anon;
revoke execute on function public.access_level_for_folder(text) from public, anon;
revoke execute on function public.find_user_by_email(text) from public, anon;
revoke execute on function public.dataset_members(uuid) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.own_new_dataset() from public, anon, authenticated;
grant execute on function public.access_level(uuid) to authenticated;
grant execute on function public.access_level_for_folder(text) to authenticated;
grant execute on function public.find_user_by_email(text) to authenticated;
grant execute on function public.dataset_members(uuid) to authenticated;

-- ── dataset files ───────────────────────────────────────────────────────────
-- Private bucket; a file's first folder is its dataset id.
insert into storage.buckets (id, name, public) values ('datasets', 'datasets', false)
on conflict (id) do nothing;

create policy "read shared dataset files" on storage.objects
  for select to authenticated using (
    bucket_id = 'datasets'
    and public.access_level_for_folder((storage.foldername(name))[1]) is not null
  );
create policy "writers upload dataset files" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'datasets'
    and public.access_level_for_folder((storage.foldername(name))[1]) in ('owner', 'write')
  );
create policy "writers replace dataset files" on storage.objects
  for update to authenticated using (
    bucket_id = 'datasets'
    and public.access_level_for_folder((storage.foldername(name))[1]) in ('owner', 'write')
  );
create policy "owners delete dataset files" on storage.objects
  for delete to authenticated using (
    bucket_id = 'datasets'
    and public.access_level_for_folder((storage.foldername(name))[1]) = 'owner'
  );
