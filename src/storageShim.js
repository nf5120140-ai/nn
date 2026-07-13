import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://axkgksyoaysvhthbxoee.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4a2drc3lvYXlzdmh0aGJ4b2VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MTMwOTUsImV4cCI6MjA5ODk4OTA5NX0.zHJHvNwmiaFRRijy1HT53thIg72ELa8w0vZmKA9MWgA";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* ====== Web Push ======
   החלף את המחרוזת הזו במפתח ה-VAPID הציבורי שתייצר (ראה README).
   זה מפתח ציבורי - מותר לחלוטין שיהיה בקוד הצד-לקוח. */
const VAPID_PUBLIC_KEY = "BG89H8Luj-qdMLB6-DN5WgdFSBsRZbs1G4iyLOwbswjB42NboDg3_G6zSLNOJngJrVzh8NobnJxsun_lsscarM0";

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

async function resetPasswordForEmail(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}

async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
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

async function deleteProfile(id) {
  const { error } = await supabase.from("profiles").delete().eq("id", id);
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

/* ---------- Web Push ---------- */

/** מפתח VAPID מגיע כ-base64url; ה-API של הדפדפן דורש Uint8Array. */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * רושם את המכשיר הנוכחי לקבלת push ושומר את המנוי ב-Supabase.
 * דורש שהרשאת ההתראות כבר ניתנה.
 */
async function registerPush() {
  if (!pushSupported()) throw new Error("push not supported");
  if (Notification.permission !== "granted") throw new Error("permission not granted");
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("PASTE_")) {
    throw new Error("VAPID public key not configured");
  }

  const reg = await navigator.serviceWorker.ready;

  // אם כבר יש מנוי למכשיר הזה נשתמש בו, אחרת ניצור חדש.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) throw new Error("not signed in");

  const orgId = await getOrgId();
  if (!orgId) throw new Error("no organization");

  const json = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: uid,
      org_id: orgId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
    },
    { onConflict: "endpoint" }
  );
  if (error) throw error;

  return true;
}

/** מבטל את המנוי של המכשיר הנוכחי (למשל כשמכבים התראות). */
async function unregisterPush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.toJSON().endpoint;
  await sub.unsubscribe();
  await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
}

/** האם המכשיר הזה כבר רשום? */
async function isPushRegistered() {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch (e) {
    return false;
  }
}

/**
 * שולח התראת push למשתמשים בארגון, דרך ה-Edge Function.
 * שקט בכוונה: אם השליחה נכשלת (אין רשת / לא נפרס עדיין),
 * ההתראה הפנימית באפליקציה עדיין עובדת - זה רק שכבה נוספת.
 */
async function sendPush({ userIds, title, body, url, tag }) {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) return { sent: 0 };

    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userIds, title, body, url, tag }),
    });

    if (!res.ok) {
      console.error("sendPush failed", res.status, await res.text());
      return { sent: 0 };
    }
    return await res.json();
  } catch (e) {
    console.error("sendPush error", e);
    return { sent: 0 };
  }
}

/* ---------- Realtime sync across devices ---------- */
async function subscribeToOrgChanges(onChange) {
  const orgId = await getOrgId();
  if (!orgId) return () => {};
  const channel = supabase
    .channel(`org-${orgId}-changes`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "kv_store", filter: `org_id=eq.${orgId}` },
      (payload) => onChange(payload)
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
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
  deleteProfile,
  resetPasswordForEmail,
  updatePassword,
  subscribeToOrgChanges,
  registerPush,
  unregisterPush,
  isPushRegistered,
  sendPush,
  pushSupported,
};
