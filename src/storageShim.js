import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://axkgksyoaysvhthbxoee.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4a2drc3lvYXlzdmh0aGJ4b2VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MTMwOTUsImV4cCI6MjA5ODk4OTA5NX0.zHJHvNwmiaFRRijy1HT53thIg72ELa8w0vZmKA9MWgA";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

let cachedOrgId = null;

async function getOrgId() {
  if (cachedOrgId) return cachedOrgId;
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase.from("profiles").select("org_id").eq("id", uid).maybeSingle();
  if (error || !data) return null;
  cachedOrgId = data.org_id;
  return cachedOrgId;
}

function resetOrgCache() {
  cachedOrgId = null;
}

/* ---------- Auth ---------- */
async function signUpCreateOrg({ email, password, orgName, displayName, phone }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { new_org_name: orgName, display_name: displayName, phone } },
  });
  if (error) throw error;
  resetOrgCache();
  return data;
}

async function signUpJoinOrg({ email, password, orgId, displayName, phone }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { join_org_id: orgId, display_name: displayName, phone } },
  });
  if (error) throw error;
  resetOrgCache();
  return data;
}

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  resetOrgCache();
  return data;
}

async function signOut() {
  await supabase.auth.signOut();
  resetOrgCache();
}

async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

async function getMyProfile() {
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
  if (error) throw error;
  if (data) cachedOrgId = data.org_id;
  return data ? { ...data, email: sessionData.session.user.email } : null;
}

async function getOrgProfiles() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at");
  if (error) throw error;
  return data || [];
}

async function updateProfile(id, fields) {
  const { error } = await supabase.from("profiles").update(fields).eq("id", id);
  if (error) throw error;
}

/* ---------- kv_store (org-scoped automatically) ---------- */
async function get(key, shared = false) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("No organization context");
  const { data, error } = await supabase
    .from("kv_store")
    .select("value")
    .eq("key", key)
    .eq("shared", shared)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { key, value: JSON.stringify(data.value), shared };
}

async function set(key, value, shared = false) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("No organization context");
  const parsed = JSON.parse(value);
  const { error } = await supabase
    .from("kv_store")
    .upsert(
      { key, shared, value: parsed, org_id: orgId, updated_at: new Date().toISOString() },
      { onConflict: "org_id,key,shared" }
    );
  if (error) throw error;
  return { key, value, shared };
}

async function del(key, shared = false) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("No organization context");
  const { error } = await supabase.from("kv_store").delete().eq("key", key).eq("shared", shared).eq("org_id", orgId);
  if (error) throw error;
  return { key, deleted: true, shared };
}

async function list(prefix = "", shared = false) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("No organization context");
  let query = supabase.from("kv_store").select("key").eq("shared", shared).eq("org_id", orgId);
  if (prefix) query = query.like("key", `${prefix}%`);
  const { data, error } = await query;
  if (error) throw error;
  return { keys: (data || []).map((r) => r.key), prefix, shared };
}

window.storage = { get, set, delete: del, list };
window.auth = {
  signUpCreateOrg,
  signUpJoinOrg,
  signIn,
  signOut,
  getSession,
  getMyProfile,
  getOrgProfiles,
  updateProfile,
};
