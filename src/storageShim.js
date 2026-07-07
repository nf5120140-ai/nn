import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://axkgksyoaysvhthbxoee.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4a2drc3lvYXlzdmh0aGJ4b2VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MTMwOTUsImV4cCI6MjA5ODk4OTA5NX0.zHJHvNwmiaFRRijy1HT53thIg72ELa8w0vZmKA9MWgA";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function get(key, shared = false) {
  const { data, error } = await supabase
    .from("kv_store")
    .select("value")
    .eq("key", key)
    .eq("shared", shared)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { key, value: JSON.stringify(data.value), shared };
}

async function set(key, value, shared = false) {
  const parsed = JSON.parse(value);
  const { error } = await supabase
    .from("kv_store")
    .upsert(
      { key, shared, value: parsed, updated_at: new Date().toISOString() },
      { onConflict: "key,shared" }
    );
  if (error) throw error;
  return { key, value, shared };
}

async function del(key, shared = false) {
  const { error } = await supabase.from("kv_store").delete().eq("key", key).eq("shared", shared);
  if (error) throw error;
  return { key, deleted: true, shared };
}

async function list(prefix = "", shared = false) {
  let query = supabase.from("kv_store").select("key").eq("shared", shared);
  if (prefix) query = query.like("key", `${prefix}%`);
  const { data, error } = await query;
  if (error) throw error;
  return { keys: (data || []).map((r) => r.key), prefix, shared };
}

window.storage = { get, set, delete: del, list };
