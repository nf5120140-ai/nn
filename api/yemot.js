/* ============================================================
   ישיבוס ← ימות המשיח (שלוחת API, type=api)
   קו טלפוני לבחורים ולצוות:
     1 - דיווח תקלה: מספר חדר ואז הקלטה (נפתחת משימה באפליקציה + התראה למנהלים)
     2 - חדר פנוי
     3 - סטטוס התקלות שדיווחתי
     4 - לצוות בלבד: שמיעת ההקלטות של התקלות הפתוחות

   משתני סביבה ב-Vercel (Settings → Environment Variables):
     SUPABASE_URL               https://axkgksyoaysvhthbxoee.supabase.co
     SUPABASE_SERVICE_ROLE_KEY  מפתח service_role מ-Supabase (סודי! רק כאן)
     YEMOT_ORG_ID               מזהה הארגון (org_id) של הישיבה
     YEMOT_SECRET               סיסמה שתמציא, וזהה לזו שבהגדרת השלוחה
   ============================================================ */

const SB_URL = process.env.SUPABASE_URL || "https://axkgksyoaysvhthbxoee.supabase.co";
// מפתחות אפשריים: זה שהוגדר ידנית, ואחריו המפתחות שהחיבור של Supabase ל-Vercel הוסיף לבד.
const cleanKey = (v) => String(v || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
const KEY_CANDIDATES = [...new Set([
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  ...Object.entries(process.env).filter(([k]) => /SUPABASE_(SERVICE_ROLE_KEY|SECRET_KEY)$/.test(k)).map(([, v]) => v),
].map(cleanKey).filter(Boolean))];
let SB_KEY = KEY_CANDIDATES[0];
let keyChecked = false;
/** בוחר את המפתח הראשון ש-Supabase מקבל (נבדק פעם אחת) */
async function pickKey() {
  if (keyChecked) return;
  for (const k of KEY_CANDIDATES) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/kv_store?select=key&limit=1`, { headers: { apikey: k, Authorization: `Bearer ${k}` } });
      if (r.ok) { SB_KEY = k; keyChecked = true; return; }
    } catch (e) {}
  }
  throw new Error("no working Supabase key (" + KEY_CANDIDATES.length + " tried)");
}
const ORG = process.env.YEMOT_ORG_ID;
const SECRET = process.env.YEMOT_SECRET;

const KEYS = {
  tasks: "kitchen-tasks",
  notifications: "kitchen-notifications",
  taskCategories: "kitchen-task-categories",
  dormRooms: "dorm-rooms",
  dormStudents: "dorm-students",
  dormDeletes: "dorm-deletes",
};

/* ---------- Supabase (REST, בלי ספריות) ---------- */
const sbHeaders = () => ({
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
});
const nsKey = (k) => `${ORG}::${k}`;

async function loadKey(base, fallback) {
  const url = `${SB_URL}/rest/v1/kv_store?select=value&org_id=eq.${ORG}&shared=eq.true&key=eq.${encodeURIComponent(nsKey(base))}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`load ${base} ${r.status}`);
  const rows = await r.json();
  return rows.length ? rows[0].value : fallback;
}

async function saveKey(base, value) {
  const r = await fetch(`${SB_URL}/rest/v1/kv_store?on_conflict=org_id,key,shared`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ org_id: ORG, key: nsKey(base), shared: true, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`save ${base} ${r.status} ${await r.text()}`);
}

async function loadProfiles() {
  const r = await fetch(`${SB_URL}/rest/v1/profiles?select=id,display_name,phone,role&org_id=eq.${ORG}`, { headers: sbHeaders() });
  return r.ok ? r.json() : [];
}

/* ---------- עזרים ---------- */
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return d;
}

// בטקסט להקראה אסור נקודה ומקף (מפרידים בימות), וגם & ו-=
const clean = (s) => String(s == null ? "" : s).replace(/[.\-&=,"'\n\r]/g, " ").replace(/\s+/g, " ").trim();
const say = (...parts) => parts.filter(Boolean).map((p) => "t-" + clean(p)).join(".");

/** בקשת הקשה מהמתקשר. name = שם הערך, maxDigits, allowed = מקשים מותרים ("123") */
function ask(prompt, name, { max = 1, min = 1, allowed = "", timeout = 10 } = {}) {
  // 1 שם,2 לא להשתמש בקודם,3 מקסימום,4 מינימום,5 זמן,6 בלי הקראה,7 חסום כוכבית,8 אפס מותר,9,10 מקשים,11-14,15 בלי אישור
  return `read=${prompt}=${name},no,${max},${min},${timeout},No,yes,no,,${allowed},,,,,no`;
}
const end = (...parts) => `id_list_message=${say(...parts)}`;

/** כל ערך נשאל אולי כמה פעמים (Cat, Cat_1, Cat_2...) – מחזיר את האחרון שהתקבל */
function lastVal(q, base) {
  let val, idx = -1;
  if (q[base] !== undefined) { val = q[base]; idx = 0; }
  for (let i = 1; i < 10; i++) if (q[`${base}_${i}`] !== undefined) { val = q[`${base}_${i}`]; idx = i; }
  const nextName = idx < 0 ? base : `${base}_${idx + 1}`;
  return { val: val === undefined ? undefined : String(val).trim(), idx, nextName };
}

const STATUS_TXT = { open: "ממתינה לטיפול", in_progress: "בטיפול", done: "טופלה" };
function ago(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "היום";
  if (days === 1) return "אתמול";
  return `לפני ${days} ימים`;
}

async function liveStudents() {
  const [students, dels] = await Promise.all([loadKey(KEYS.dormStudents, []), loadKey(KEYS.dormDeletes, [])]);
  const gone = new Set(dels || []);
  return (students || []).filter((s) => s && !gone.has(s.id));
}

/* ---------- השיחה ---------- */
const extPath = (q) => "/" + String(q.ApiExtension || "").replace(/^\/+|\/+$/g, "");
const recName = (q) => "T" + String(q.ApiCallId || genId()).replace(/[^a-zA-Z0-9]/g, "").slice(-12);

async function handle(q) {
  const phone = normPhone(q.ApiPhone);
  const [students, profiles] = await Promise.all([liveStudents(), loadProfiles()]);
  const me = phone.length >= 9 ? students.find((s) => normPhone(s.phone) === phone) : null;
  const staff = phone.length >= 9 ? profiles.find((p) => normPhone(p.phone) === phone) : null;
  const callerName = (me && me.name) || (staff && staff.display_name) || "";

  const allowed = staff ? "1234" : "123";
  const menu = lastVal(q, "Menu");
  if (!menu.val || !allowed.includes(menu.val)) {
    if (q.hangup === "yes") return "noop=hangup";
    if (menu.idx >= 2) return end("לא התקבלה בחירה", "להתראות");
    const hello = menu.idx < 0 ? (callerName ? `שלום ${callerName}` : "שלום") : "";
    return ask(
      say(hello, "לדיווח על תקלה הקישו 1", "לחדר פנוי הקישו 2", "לבדיקת סטטוס תקלה הקישו 3",
        staff ? "לשמיעת התקלות הפתוחות הקישו 4" : ""),
      menu.nextName, { allowed }
    );
  }

  if (menu.val === "1") return report(q, { phone, staff, callerName, profiles });
  if (q.hangup === "yes") return "noop=hangup";
  if (menu.val === "2") return freeRoom(students);
  if (menu.val === "3") return status(phone);
  return playOpen(q);
}

async function report(q, { phone, staff, callerName, profiles }) {
  const hung = q.hangup === "yes";
  const rooms = (await loadKey(KEYS.dormRooms, [])) || [];
  const roomNums = new Set(rooms.map((r) => String(r.num)));

  // מספר חדר
  const r = lastVal(q, "Room");
  const okRoom = r.val && /^\d+$/.test(r.val) && (roomNums.size === 0 || roomNums.has(String(Number(r.val))));
  if (!okRoom) {
    if (hung) return "noop=hangup";
    if (r.idx >= 2) return end("מספר החדר לא נמצא", "להתראות");
    return ask(say(r.val ? "החדר לא נמצא ברשימה" : "", "הקישו מספר חדר ולאחריו סולמית"), r.nextName, { max: 4, timeout: 15 });
  }
  const room = String(Number(r.val));

  // הקלטת התקלה (נשמרת בימות, בתיקיית השלוחה)
  const rec = lastVal(q, "Rec");
  const file = recName(q);
  if (!rec.val || rec.val === "None") {
    if (hung) return "noop=hangup";
    if (rec.idx >= 1) return end("לא התקבלה הקלטה", "להתראות");
    // 1 שם, 2 לא להשתמש בקודם, 3 הקלטה, 4 תיקייה, 5 שם קובץ, 6 אישור מיידי בסולמית, 7 לשמור גם בניתוק, 8 לא לשרשר, 9 מינימום שניות, 10 מקסימום
    return `read=${say(`חדר ${room}`, "לאחר הצליל תארו את התקלה ובסיום הקישו סולמית")}=${rec.nextName},no,record,${extPath(q)},${file},no,yes,no,1,90`;
  }

  // פתיחת המשימה (בלי כפילות אם ימות שולח שוב את אותה בקשה)
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  const callId = String(q.ApiCallId || "");
  if (!callId || !tasks.some((t) => t && t.ivrCallId === callId)) {
    const title = `תקלה · חדר ${room}`;
    const reporter = callerName || `טלפון ${phone}`;
    const task = {
      id: genId(),
      title,
      description: `דווח בטלפון ע"י ${reporter}${phone ? ` (${phone})` : ""}. התקלה הוקלטה - לשמיעה: להתקשר לקו, להיכנס לשלוחת התקלות ולהקיש 4.`,
      assignedToId: "",
      priority: "normal",
      location: `חדר ${room}`,
      locationId: "",
      categoryId: "",
      status: "open",
      createdAt: Date.now(),
      createdBy: reporter,
      createdById: staff ? staff.id : undefined,
      comments: [],
      source: "ivr",
      reporterPhone: phone,
      ivrCallId: callId,
      ivrRecording: `${extPath(q)}/${file}`,
    };
    await saveKey(KEYS.tasks, [task, ...tasks]);
    await notifyManagers(profiles, `☎️ דיווח טלפוני מ${reporter}: ${title}`, task.id);
  }
  return hung ? "noop=hangup" : end("התקלה נקלטה ותטופל בעזרת השם", "תודה ולהתראות");
}

async function notifyManagers(profiles, message, taskId) {
  const managers = profiles.filter((p) => p.role === "manager");
  if (!managers.length) return;
  const link = { tab: "tasks", taskId };
  try {
    const list = (await loadKey(KEYS.notifications, [])) || [];
    const items = managers.map((m) => ({ id: genId(), userId: m.id, message, link, read: false, createdAt: Date.now() }));
    await saveKey(KEYS.notifications, [...list, ...items]);
  } catch (e) { console.error("notif", e); }
  // push – שכבה נוספת; אם נכשל, ההתראה באפליקציה כבר נשמרה
  try {
    await fetch(`${SB_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({ userIds: managers.map((m) => m.id), title: "ישיבוס", body: message, url: `/?tab=tasks&taskId=${taskId}&org=${ORG}` }),
    });
  } catch (e) { console.error("push", e); }
}

async function status(phone) {
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  const mine = tasks
    .filter((t) => t && t.source === "ivr" && t.reporterPhone === phone)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 3);
  if (!mine.length) return end("לא נמצאו תקלות שדיווחתם מהטלפון הזה", "להתראות");
  const lines = mine.map((t) => `תקלה ב${t.location || "חדר"} שדווחה ${ago(t.createdAt)}: ${STATUS_TXT[t.status] || "ממתינה לטיפול"}`);
  return end(...lines, "להתראות");
}

/** חדר פנוי: קודם חדרים ריקים לגמרי, אחר כך חדרים עם הכי הרבה מיטות פנויות */
async function freeRoom(students) {
  const rooms = (await loadKey(KEYS.dormRooms, [])) || [];
  const count = new Map();
  students.forEach((s) => { if (s.room) count.set(String(s.room), (count.get(String(s.room)) || 0) + 1); });
  const free = rooms
    .map((r) => {
      const used = count.get(String(r.num)) || 0;
      const beds = Number(r.beds) || 0;
      return { num: r.num, used, left: beds > 0 ? beds - used : (used === 0 ? 1 : 0), beds };
    })
    .filter((r) => r.left > 0)
    .sort((a, b) => (a.used === 0 ? 0 : 1) - (b.used === 0 ? 0 : 1) || b.left - a.left || Number(a.num) - Number(b.num))
    .slice(0, 3);
  if (!free.length) return end("אין כרגע חדרים פנויים", "להתראות");
  const lines = free.map((r) =>
    r.used === 0 ? `חדר ${r.num} ריק${r.beds ? ` ויש בו ${r.beds} מיטות` : ""}`
      : `בחדר ${r.num} ${r.left === 1 ? "מיטה פנויה אחת" : `${r.left} מיטות פנויות`}`);
  return end("חדרים פנויים", ...lines, "לשיבוץ פנו להנהלה", "להתראות");
}

/** לצוות: השמעת ההקלטות של התקלות הפתוחות שדווחו בטלפון */
async function playOpen(q) {
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  const open = tasks
    .filter((t) => t && t.source === "ivr" && t.ivrRecording && t.status !== "done")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 6);
  if (!open.length) return end("אין תקלות טלפוניות פתוחות", "להתראות");
  const parts = [];
  open.forEach((t) => {
    parts.push("t-" + clean(`${t.location} דווח ${ago(t.createdAt)}`));
    parts.push("f-" + String(t.ivrRecording).replace(/[^a-zA-Z0-9/_]/g, ""));
  });
  parts.push("t-" + clean("סוף הרשימה להתראות"));
  return "id_list_message=" + parts.join(".");
}

/* ---------- Vercel handler ---------- */
export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const q = { ...(req.query || {}), ...(typeof req.body === "object" && req.body ? req.body : {}) };

  if (!SB_KEY || !ORG || !SECRET) return res.status(200).send(end("המערכת אינה מוגדרת"));
  if (q.key !== SECRET) return res.status(200).send(end("אין הרשאה"));

  try {
    await pickKey();
    res.status(200).send(await handle(q));
  } catch (e) {
    console.error(e);
    res.status(200).send(end("אירעה תקלה במערכת", "נסו שוב מאוחר יותר"));
  }
}
