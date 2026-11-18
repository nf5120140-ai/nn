/* ============================================================
   ישיבוס ← ימות המשיח (שלוחת API, type=api)
   קו טלפוני לבחורים ולצוות:
     1 - דיווח תקלה בחדר (נפתחת משימה באפליקציה + התראה למנהלים)
     2 - מה קרה עם התקלות שדיווחתי
     3 - בירור חדרים (בחור: החדר שלו ומי איתו; איש צוות: מי גר בכל חדר)

   משתני סביבה ב-Vercel (Settings → Environment Variables):
     SUPABASE_URL               https://axkgksyoaysvhthbxoee.supabase.co
     SUPABASE_SERVICE_ROLE_KEY  מפתח service_role מ-Supabase (סודי! רק כאן)
     YEMOT_ORG_ID               מזהה הארגון (org_id) של הישיבה
     YEMOT_SECRET               סיסמה שתמציא, וזהה לזו שבהגדרת השלוחה
   ============================================================ */

const SB_URL = process.env.SUPABASE_URL || "https://axkgksyoaysvhthbxoee.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
async function handle(q) {
  const phone = normPhone(q.ApiPhone);
  const [students, profiles] = await Promise.all([liveStudents(), loadProfiles()]);
  const me = phone.length >= 9 ? students.find((s) => normPhone(s.phone) === phone) : null;
  const staff = phone.length >= 9 ? profiles.find((p) => normPhone(p.phone) === phone) : null;
  const callerName = (me && me.name) || (staff && staff.display_name) || "";

  const menu = lastVal(q, "Menu");
  if (!menu.val || !["1", "2", "3"].includes(menu.val)) {
    if (menu.idx >= 2) return end("לא התקבלה בחירה", "להתראות");
    const hello = menu.idx < 0 ? (callerName ? `שלום ${callerName}` : "שלום") : "";
    return ask(
      say(hello, "לדיווח על תקלה הקישו 1", "לבירור מצב התקלות שדיווחתם הקישו 2", "לבירור חדרים הקישו 3"),
      menu.nextName, { allowed: "123" }
    );
  }

  if (menu.val === "1") return report(q, { phone, me, staff, callerName, profiles });
  if (menu.val === "2") return status(q, { phone, me });
  return roomLookup(q, { me, staff, students });
}

async function report(q, { phone, me, staff, callerName, profiles }) {
  const rooms = (await loadKey(KEYS.dormRooms, [])) || [];
  const roomNums = new Set(rooms.map((r) => String(r.num)));

  // חדר: בחור מזוהה – החדר שלו. אחרת – מקיש.
  let room = me && me.room ? String(me.room) : null;
  if (!room) {
    const r = lastVal(q, "Room");
    const okRoom = r.val && /^\d+$/.test(r.val) && (roomNums.size === 0 || roomNums.has(String(Number(r.val))));
    if (!okRoom) {
      if (r.idx >= 2) return end("מספר החדר לא נמצא", "להתראות");
      return ask(say(r.val ? "החדר לא נמצא ברשימה" : "", "הקישו את מספר החדר ובסיומו סולמית"), r.nextName, { max: 4, timeout: 15 });
    }
    room = String(Number(r.val));
  }

  // קטגוריה
  const cats = ((await loadKey(KEYS.taskCategories, [])) || []).filter((c) => c && c.name);
  let cat = null;
  if (cats.length) {
    const c = lastVal(q, "Cat");
    const n = Number(c.val);
    cat = Number.isInteger(n) && n >= 1 && n <= cats.length ? cats[n - 1] : null;
    if (!cat) {
      if (c.idx >= 2) return end("לא התקבלה בחירה", "להתראות");
      const list = cats.map((x, i) => `ל${x.name} הקישו ${i + 1}`);
      const max = String(cats.length).length;
      return ask(say(me && c.idx < 0 ? `דיווח על תקלה בחדר ${room}` : "", "בחרו את סוג התקלה", ...list), c.nextName,
        { max, allowed: max === 1 ? cats.map((_, i) => i + 1).join("") : "", timeout: max > 1 ? 5 : 10 });
    }
  }

  // דחיפות
  const u = lastVal(q, "Urg");
  if (!["1", "2"].includes(u.val)) {
    if (u.idx >= 2) return end("לא התקבלה בחירה", "להתראות");
    return ask(say("אם התקלה דחופה הקישו 1", "אם לא הקישו 2"), u.nextName, { allowed: "12" });
  }
  const urgent = u.val === "1";

  // אישור
  const ok = lastVal(q, "Ok");
  if (!["1", "2"].includes(ok.val)) {
    if (ok.idx >= 2) return end("הדיווח בוטל", "להתראות");
    return ask(
      say(`דיווח על תקלת ${cat ? cat.name : ""} בחדר ${room}`, urgent ? "דחוף" : "", "לאישור הקישו 1", "לביטול הקישו 2"),
      ok.nextName, { allowed: "12" }
    );
  }
  if (ok.val === "2") return end("הדיווח בוטל", "להתראות");

  // פתיחת המשימה (בלי כפילות אם ימות שולח שוב את אותה בקשה)
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  const callId = String(q.ApiCallId || "");
  if (!callId || !tasks.some((t) => t && t.ivrCallId === callId)) {
    const title = `${cat ? cat.name : "תקלה"} · חדר ${room}`;
    const reporter = callerName || `טלפון ${phone}`;
    const task = {
      id: genId(),
      title,
      description: `דווח בטלפון ע"י ${reporter}${phone ? ` (${phone})` : ""}`,
      assignedToId: "",
      priority: urgent ? "urgent" : "normal",
      location: `חדר ${room}`,
      locationId: "",
      categoryId: cat ? cat.id : "",
      status: "open",
      createdAt: Date.now(),
      createdBy: reporter,
      createdById: staff ? staff.id : undefined,
      comments: [],
      source: "ivr",
      reporterPhone: phone,
      ivrCallId: callId,
    };
    await saveKey(KEYS.tasks, [task, ...tasks]);
    await notifyManagers(profiles, `☎️ ${urgent ? "דחוף! " : ""}דיווח טלפוני מ${reporter}: ${title}`, task.id);
  }
  return end("התקלה נקלטה ותטופל בעזרת השם", "תודה ולהתראות");
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

async function status(q, { phone, me }) {
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  const roomLoc = me && me.room ? `חדר ${me.room}` : null;
  const mine = tasks
    .filter((t) => t && (t.reporterPhone === phone || (roomLoc && t.source === "ivr" && t.location === roomLoc)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 3);
  if (!mine.length) return end("לא נמצאו תקלות שדיווחתם", "להתראות");
  const lines = mine.map((t) => `תקלת ${t.title.replace("·", "ב")} שדווחה ${ago(t.createdAt)}: ${STATUS_TXT[t.status] || "ממתינה לטיפול"}`);
  return end(...lines, "להתראות");
}

async function roomLookup(q, { me, staff, students }) {
  const namesIn = (num) => students.filter((s) => String(s.room) === String(num)).map((s) => s.name);

  if (!staff) {
    if (!me) return end("המספר שלכם לא רשום במערכת", "לבירור פנו להנהלה");
    if (!me.room) return end(`${me.name}`, "עדיין לא שובצת לחדר");
    const others = namesIn(me.room).filter((n) => n !== me.name);
    return end(`${me.name} אתה בחדר ${me.room}`, others.length ? `איתך בחדר: ${others.join(" ו")}` : "אתה לבד בחדר");
  }

  // איש צוות – בירור לפי מספר חדר, אפשר כמה חדרים ברצף
  const r = lastVal(q, "LRoom");
  const prev = r.val && /^\d+$/.test(r.val) ? String(Number(r.val)) : null;
  let info = "";
  if (prev) {
    const names = namesIn(prev);
    info = names.length ? `בחדר ${prev}: ${names.join(" ו")}` : `חדר ${prev} ריק או לא קיים`;
  }
  if (r.idx >= 8) return end(info, "להתראות");
  return ask(say(info, "להקשת מספר חדר ובסיומו סולמית", "לסיום נתקו"), r.nextName, { max: 4, timeout: 20 });
}

/* ---------- Vercel handler ---------- */
export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const q = { ...(req.query || {}), ...(typeof req.body === "object" && req.body ? req.body : {}) };

  if (q.hangup === "yes") return res.status(200).send("noop=hangup");
  if (!SB_KEY || !ORG || !SECRET) return res.status(200).send(end("המערכת אינה מוגדרת"));
  if (q.key !== SECRET) return res.status(200).send(end("אין הרשאה"));

  try {
    res.status(200).send(await handle(q));
  } catch (e) {
    console.error(e);
    res.status(200).send(end("אירעה תקלה במערכת", "נסו שוב מאוחר יותר"));
  }
}
