create policy profiles_delete on profiles for delete using (org_id = public.current_user_org_id());
