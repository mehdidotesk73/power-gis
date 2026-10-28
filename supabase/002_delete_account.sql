-- PowerGIS: let a signed-in user delete their own account.
-- Run once in the Supabase SQL editor, after schema.sql.
--
-- The app's key can't delete accounts, so this function (running as the
-- database owner) deletes only the caller's: first the datasets they own
-- (people they shared them with lose them too), then the account itself,
-- which takes their profile, access rows and workspaces with it. Datasets
-- others shared with them stay with their owners. The app removes the owned
-- datasets' files from storage before calling this.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Sign in first.';
  end if;
  delete from public.datasets d
  using public.dataset_access a
  where a.dataset_id = d.id and a.user_id = me and a.access = 'owner';
  delete from auth.users where id = me;
end $$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
