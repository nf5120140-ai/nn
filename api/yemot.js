/* ============================================================
   ישיבוס ← ימות המשיח (שלוחת API, type=api)
   קו טלפוני לבחורים ולצוות:
     מספרים של המעון (רשומים באפליקציה) – ישר לדיווח תקלה במעון: בוחרים כיתה (מהמיקומים בקבוצת "מעון" באפליקציה, 0 = אחר), מקליטים,
       והמשימה נפתחת עם הכיתה כמיקום (או "מעון" אם בחרו 0).
     1 - דיווח תקלה: הקלטה חופשית (אם אומרים מספר חדר – הוא מזוהה לבד), ותמלול לטקסט בג'מיני (נפתחת משימה באפליקציה + התראה למנהלים)
         בחור יכול לדווח פעם אחת בשבוע (ראשון עד שבת), לפי מספר הטלפון שממנו התקשר. צוות ואחראי חדרים – בלי הגבלה.
     2 - אחראי חדרים (רק עם קוד אישי שמוגדר באפליקציה: ניהול חדרים ← טלפון):
           1 חדרים פנויים
           2 שיבוץ בחור למיטה פנויה – לפי מספר הטלפון של הבחור, או הקלטת השם (תמלול בג'מיני)
         כל פעולה נרשמת ביומן "טלפון" במסך ניהול החדרים, והבחור מסומן ☎️ בטבלאות עד שמסמנים "נבדק".
     3 - סטטוס התקלות שדיווחתי
     4 - לצוות בלבד: הקראת התקלות הפתוחות

   משתני סביבה ב-Vercel (Settings → Environment Variables):
     SUPABASE_URL               https://axkgksyoaysvhthbxoee.supabase.co
     SUPABASE_SERVICE_ROLE_KEY  מפתח service_role מ-Supabase (סודי! רק כאן)
     YEMOT_ORG_ID               מזהה הארגון (org_id) של הישיבה
     YEMOT_SECRET               סיסמה שתמציא, וזהה לזו שבהגדרת השלוחה
     YEMOT_TOKEN                מספר המערכת:סיסמת הניהול (להורדת ההקלטה לתמלול)
     GEMINI_API_KEY             מפתח Gemini מ-aistudio.google.com
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
const YEMOT_TOKEN = process.env.YEMOT_TOKEN;      // מספר המערכת:סיסמת הניהול, למשל 0772029287:1234
const GEMINI_KEY = process.env.GEMINI_API_KEY;    // מפתח מ-aistudio.google.com

const KEYS = {
  tasks: "kitchen-tasks",
  notifications: "kitchen-notifications",
  taskCategories: "kitchen-task-categories",
  dormRooms: "dorm-rooms",
  dormStudents: "dorm-students",
  dormDeletes: "dorm-deletes",
  ivrAuth: "dorm-ivr-auth",       // אחראי חדרים בטלפון: [{ id, name, phone, code, active }] – מנוהל באפליקציה
  ivrLog: "dorm-ivr-log",         // יומן פעולות חדרים מהטלפון
  ivrReports: "ivr-report-log",   // מי דיווח תקלה מתי (להגבלה של פעם בשבוע)
  ivrCache: "ivr-cache",          // תמלולים זמניים בתוך שיחה
  maonPhones: "ivr-maon-phones",
  locations: "kitchen-locations",  // המיקומים של האפליקציה – הכיתות של המעון הן הקבוצה שבשמה "מעון"  // מספרי המעון: [{ id, name, phone, active }] – מנוהל באפליקציה (ניהול חדרים ← טלפון)
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

/** תחילת השבוע הנוכחי (יום ראשון 00:00 שעון ישראל) */
function weekStart(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const y = +p.year, mo = +p.month - 1, d = +p.day;
  const offset = Date.UTC(y, mo, d, +p.hour, +p.minute, +p.second) - Math.floor(now / 1000) * 1000;
  const dow = new Date(Date.UTC(y, mo, d)).getUTCDay();
  return Date.UTC(y, mo, d - dow) - offset;
}

// כמו nameKey באפליקציה: מתעלם מרווחים, גרשיים ומקפים
const nameKey = (s) => String(s || "").replace(/["'׳״‘’“”.]/g, "").replace(/[-־–—]/g, " ").replace(/\s+/g, " ").trim();
const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : "d" + genId());

async function liveStudents() {
  const [students, dels] = await Promise.all([loadKey(KEYS.dormStudents, []), loadKey(KEYS.dormDeletes, [])]);
  const gone = new Set(dels || []);
  return (students || []).filter((s) => s && !gone.has(s.id));
}

/** רישום ביומן הטלפון של ניהול החדרים (נשמרות 500 הפעולות האחרונות) */
async function logIvr(entry) {
  try {
    const list = (await loadKey(KEYS.ivrLog, [])) || [];
    if (entry.dedupe && list.some((e) => e && e.dedupe === entry.dedupe)) return;
    await saveKey(KEYS.ivrLog, [{ id: genId(), at: Date.now(), ...entry }, ...list].slice(0, 500));
  } catch (e) { console.error("ivr log", e); }
}

/* ---------- השיחה ---------- */
const extPath = (q) => "/" + String(q.ApiExtension || "").replace(/^\/+|\/+$/g, "");
const recFile = (q, prefix, idx) => prefix + String(q.ApiCallId || genId()).replace(/[^a-zA-Z0-9]/g, "").slice(-12) + (idx > 0 ? "x" + idx : "");
// ימות מחזירה את נתיב הקובץ שנשמר; אם לא – בונים אותו לבד
const recPathOf = (q, val, file) => (/^\/?[\w/]+\.(wav|mp3)$/i.test(val) ? "/" + val.replace(/^\/+/, "") : `${extPath(q).replace(/\/+$/, "")}/${file}.wav`);
const noRec = (v) => !v || /^None$/i.test(v);

async function handle(q) {
  const phone = normPhone(q.ApiPhone);
  const known = phone.length >= 9;
  const [students, profiles, auth, maonList] = await Promise.all([liveStudents(), loadProfiles(), loadKey(KEYS.ivrAuth, []), loadKey(KEYS.maonPhones, [])]);
  const me = known ? students.find((s) => normPhone(s.phone) === phone) : null;
  const staff = known ? profiles.find((p) => normPhone(p.phone) === phone) : null;
  const roomMgr = known ? (auth || []).find((a) => a && a.active !== false && normPhone(a.phone) === phone) : null;
  const callerName = (me && me.name) || (staff && staff.display_name) || (roomMgr && roomMgr.name) || "";

  // אחראי חדרים רשום (לפי מספר הטלפון) – ישר לתפריט החדרים, בלי התפריט הראשי
  if (roomMgr) {
    if (q.hangup === "yes") return "noop=hangup";
    return roomsMenu(q, { phone, students, profiles, auth, staff, roomMgr, callerName });
  }

  // מספר של המעון – ישר לדיווח תקלה במעון (משימה מסומנת "מעון", בלי חדר ובלי הגבלה שבועית)
  const maon = known ? (maonList || []).find((m) => m && m.active !== false && normPhone(m.phone) === phone) : null;
  if (maon) return report(q, { phone, staff, roomMgr, callerName: maon.name || callerName, profiles, maon });

  // 2 פתוח לכולם אבל דורש קוד; מוקרא רק לצוות
  const allowed = staff ? "1234" : "123";
  const menu = lastVal(q, "Menu");
  if (!menu.val || !allowed.includes(menu.val)) {
    if (q.hangup === "yes") return "noop=hangup";
    if (menu.idx >= 2) return end("לא התקבלה בחירה", "להתראות");
    const hello = menu.idx < 0 ? (callerName ? `שלום ${callerName}` : "שלום") : "";
    return ask(
      say(hello, "לדיווח תקלה הקישו 1", staff ? "לחדרים הקישו 2" : "", "לסטטוס תקלה הקישו 3", staff ? "לתקלות הפתוחות הקישו 4" : ""),
      menu.nextName, { allowed }
    );
  }

  if (menu.val === "1") return report(q, { phone, staff, roomMgr, callerName, profiles });
  if (q.hangup === "yes") return "noop=hangup";
  if (menu.val === "2") return roomsMenu(q, { phone, students, profiles, auth, staff, roomMgr, callerName });
  if (menu.val === "3") return status(phone);
  return playOpen();
}

/** מוריד הקלטה מימות ושולח לג'מיני לתמלול. מחזיר { text, err } */
// הקלטה טלפונית (8kHz, לפעמים חלשה ורועשת) – נותנים לג'מיני הקשר כדי שינחש נכון מילים שלא נשמעו טוב.
// בדיווח תקלה אין הקשת חדר: אם אמרו מספר חדר בהקלטה – ג'מיני מוציא אותו, ואם לא – המשימה נפתחת בלי חדר.
const FAULT_TERMS = "מזגן, שלט מזגן, דוד, מים חמים, נזילה, טפטוף, סתימה, ניאגרה, כיור, ברז, מקלחת, אסלה, נורה, מנורה, תאורה, שקע, חשמל, מפסק, קצר, ממסר, תריס, חלון, זכוכית, ידית, דלת, מנעול, מפתח, מיטה, מזרן, ארון, מדף, כסא, שולחן, וילון, מאוורר, תנור, רדיאטור, קיר, תקרה, רטיבות, עובש, ריח, ג'וקים, נמלים, עכברים, מקרר, פח, אינטרקום, רמקול";
const FAULT_PROMPT = "זו הקלטה טלפונית בעברית (איכות נמוכה, אולי רעש רקע) של בחור או איש צוות בישיבה שמדווח על תקלה – בחדר בפנימייה או בכל מקום אחר בישיבה. "
  + "מילים נפוצות בדיווחים כאלה: " + FAULT_TERMS + ". "
  + "אם המדווח אמר מספר חדר (למשל \"חדר מאתיים ושלוש\" או \"בחדר 203\") – זה מספר החדר. אם לא אמר מספר חדר – אל תנחש. "
  + "ענה בדיוק בשתי שורות, בלי שום דבר נוסף:\n"
  + "חדר: <מספר החדר בספרות, או ריק אם לא נאמר>\n"
  + "תקלה: <מה התקלה, במשפט או שניים קצרים וברורים, בלי מספר החדר>\n"
  + "אם מילה לא נשמעה טוב, בחר את המילה הסבירה ביותר בהקשר של תקלה במבנה. אל תמציא פרטים שלא נאמרו. אם לא נאמר כלום כתוב בשורת התקלה: ריק.";
// מעון: אותו פורמט תשובה, אבל בלי חדרי הפנימייה – כל מקום שנאמר נשאר בתוך התיאור
const MAON_PROMPT = "זו הקלטה טלפונית בעברית (איכות נמוכה, אולי רעש רקע) של איש צוות במעון של הישיבה שמדווח על תקלה. "
  + "מילים נפוצות בדיווחים כאלה: " + FAULT_TERMS + ", גן, כיתה, חצר, מתקן, עריסה, מטבחון. "
  + "ענה בדיוק בשתי שורות, בלי שום דבר נוסף:\n"
  + "חדר: ריק\n"
  + "תקלה: <מה התקלה ואיפה במעון, במשפט או שניים קצרים וברורים>\n"
  + "אם מילה לא נשמעה טוב, בחר את המילה הסבירה ביותר בהקשר של תקלה במבנה. אל תמציא פרטים שלא נאמרו. אם לא נאמר כלום כתוב בשורת התקלה: ריק.";
const namePrompt = (names) => "זו הקלטה טלפונית קצרה בעברית (איכות נמוכה) שבה אומרים שם של בחור בישיבה: שם פרטי ושם משפחה, לפעמים גם שם האב או העיר. "
  + (names && names.length ? "אלה הבחורים שכבר רשומים בישיבה: " + names.join(", ") + ". אם השם שנאמר הוא אחד מהם (גם אם לא נשמע מושלם), כתוב אותו בדיוק כמו ברשימה. אם לא – כתוב את השם כפי שנשמע, בכתיב הנפוץ. " : "")
  + "כתוב רק את השם באותיות עבריות, בלי ניקוד ובלי שום מילה נוספת. אם לא נאמר שם כתוב ריק.";

/* ---------- שיפור ההקלטה לפני התמלול ----------
   ימות שומרת WAV טלפוני. מנקים את זה: מסננים זמזום נמוך והיסט, ומגבירים עד עוצמה תקינה (עד פי 10).
   אם הפורמט לא מוכר – שולחים את הקובץ כמו שהוא. */
const ULAW = (u) => { u = ~u & 0xff; const t = ((u & 0x0f) << 3) + 0x84; const v = (t << ((u & 0x70) >> 4)) - 0x84; return u & 0x80 ? -v : v; };
const ALAW = (a) => { a ^= 0x55; let t = (a & 0x0f) << 4; const seg = (a & 0x70) >> 4; t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1); return a & 0x80 ? t : -t; };
function enhanceWav(buf) {
  try {
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    let pos = 12, fmt = null, data = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
      if (id === "fmt ") fmt = { format: buf.readUInt16LE(pos + 8), ch: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
      else if (id === "data") data = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
      pos += 8 + size + (size & 1);
    }
    if (!fmt || !data || fmt.ch !== 1) return null;
    let x;
    if (fmt.format === 1 && fmt.bits === 16) { x = new Float32Array(data.length >> 1); for (let i = 0; i < x.length; i++) x[i] = data.readInt16LE(i * 2); }
    else if (fmt.format === 1 && fmt.bits === 8) { x = new Float32Array(data.length); for (let i = 0; i < x.length; i++) x[i] = (data[i] - 128) * 256; }
    else if (fmt.format === 7 && fmt.bits === 8) { x = new Float32Array(data.length); for (let i = 0; i < x.length; i++) x[i] = ULAW(data[i]); }
    else if (fmt.format === 6 && fmt.bits === 8) { x = new Float32Array(data.length); for (let i = 0; i < x.length; i++) x[i] = ALAW(data[i]); }
    else return null;
    if (x.length < 800) return null;
    // מסנן מעביר-גבוהים (~120Hz) – מוריד זמזום, רעש רוח והיסט DC
    const a = Math.exp(-2 * Math.PI * 120 / fmt.rate);
    let px = x[0], py = 0;
    for (let i = 0; i < x.length; i++) { const y = a * (py + x[i] - px); px = x[i]; py = y; x[i] = y; }
    // הגברה לפי השיא האמיתי (מתעלמים מ-0.1% הקפיצות הכי חזקות)
    const abs = Float32Array.from(x, Math.abs).sort();
    const peak = abs[Math.floor(abs.length * 0.999)] || 1;
    const gain = Math.min(10, 26000 / peak);
    const out = Buffer.alloc(44 + x.length * 2);
    out.write("RIFF", 0); out.writeUInt32LE(36 + x.length * 2, 4); out.write("WAVE", 8);
    out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
    out.writeUInt32LE(fmt.rate, 24); out.writeUInt32LE(fmt.rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
    out.write("data", 36); out.writeUInt32LE(x.length * 2, 40);
    for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * gain))), 44 + i * 2);
    return out;
  } catch (e) { console.error("enhance", e); return null; }
}

async function transcribe(path, prompt = FAULT_PROMPT) {
  if (!YEMOT_TOKEN) return { text: "", err: "חסר YEMOT_TOKEN ב-Vercel" };
  if (!GEMINI_KEY) return { text: "", err: "חסר GEMINI_API_KEY ב-Vercel" };
  let audio, mime = "audio/wav";
  try {
    const dl = await fetch(`https://www.call2all.co.il/ym/api/DownloadFile?token=${encodeURIComponent(YEMOT_TOKEN)}&path=${encodeURIComponent("ivr2:" + path)}`);
    const type = dl.headers.get("content-type") || "";
    const buf = Buffer.from(await dl.arrayBuffer());
    if (!dl.ok || type.includes("json") || type.includes("text") || buf.length < 1000) {
      return { text: "", err: `הורדה מימות נכשלה (${dl.status}): ${buf.toString("utf8").slice(0, 120)}` };
    }
    if (type.includes("mpeg") || type.includes("mp3")) mime = "audio/mp3";
    const better = mime === "audio/wav" ? enhanceWav(buf) : null;
    audio = (better || buf).toString("base64");
  } catch (e) { return { text: "", err: "הורדה מימות נכשלה: " + e.message }; }
  // מודל: מה שהוגדר ב-GEMINI_MODEL, אחרת "flash-latest". אם גוגל אומרת שהמודל הוחלף – עוברים למודל שהיא מציעה
  const models = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-flash-lite-latest"].filter(Boolean);
  let lastErr = "";
  const busyRetried = new Set();
  for (let i = 0; i < models.length && i < 6; i++) {
    try {
      const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: audio } },
          ] }],
        }),
      });
      if (!g.ok) {
        const body = await g.text();
        let msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
        lastErr = `ג'מיני נכשל (${g.status}, ${models[i]}): ${String(msg).slice(0, 120)}`;
        // עומס זמני – מחכים רגע ומנסים שוב את אותו מודל פעם אחת, ואחר כך עוברים למודל הבא
        if ([429, 500, 503].includes(g.status) && !busyRetried.has(models[i])) {
          busyRetried.add(models[i]);
          await new Promise((r) => setTimeout(r, 1500));
          i--;
          continue;
        }
        const suggested = String(msg).match(/models\/([\w.\-]+)/g);
        const next = suggested && suggested.map((m) => m.replace("models/", "").replace(/[.\-]+$/, "")).find((m) => !models.includes(m));
        if (next) models.push(next);
        continue;
      }
      const j = await g.json();
      const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" ").replace(/\s+/g, " ").trim();
      return t === "ריק" || !t ? { text: "", err: "ג'מיני לא זיהה דיבור בהקלטה" } : { text: t, err: "" };
    } catch (e) { lastErr = "ג'מיני נכשל: " + e.message; }
  }
  return { text: "", err: lastErr };
}

/** תמלול ששמור לכל השיחה – כדי שבשלב האישור לא נתמלל שוב ונקבל שם אחר */
async function cachedTranscribe(q, tag, path, prompt) {
  const key = `${q.ApiCallId || ""}:${tag}`;
  let cache = {};
  try { cache = (await loadKey(KEYS.ivrCache, {})) || {}; } catch (e) {}
  if (q.ApiCallId && cache[key]) return cache[key];
  const r = await transcribe(path, prompt);
  const now = Date.now();
  const next = Object.fromEntries(Object.entries(cache).filter(([, v]) => v && now - (v.at || 0) < 3 * 3600e3));
  next[key] = { ...r, at: now };
  try { await saveKey(KEYS.ivrCache, next); } catch (e) {}
  return r;
}

/* ---------- 1: דיווח תקלה ---------- */
async function report(q, { phone, staff, roomMgr, callerName, profiles, maon }) {
  const hung = q.hangup === "yes";
  const callId = String(q.ApiCallId || "");

  // בחור: תקלה אחת בשבוע לכל מספר טלפון (צוות ואחראי חדרים – בלי הגבלה)
  const limited = !staff && !roomMgr && !maon;
  if (limited) {
    if (phone.length < 9) return hung ? "noop=hangup" : end("המספר שלכם חסוי", "כדי לדווח על תקלה יש להתקשר ממספר מזוהה", "להתראות");
    const weekLog = (await loadKey(KEYS.ivrReports, [])) || [];
    const since = weekStart();
    const used = weekLog.find((e) => e && e.phone === phone && e.at >= since && (!callId || e.callId !== callId));
    if (used) {
      return hung ? "noop=hangup" : end("כבר דווחה השבוע תקלה מהטלפון הזה", `הדיווח נקלט ${ago(used.at)}`,
        "אפשר לדווח שוב החל מיום ראשון", "לבדיקת סטטוס התקלה התקשרו והקישו 3", "להתראות");
    }
  }

  const rooms = (await loadKey(KEYS.dormRooms, [])) || [];
  const roomNums = new Set(rooms.map((r) => String(Number(r.num))));

  // מעון: בחירת כיתה מתוך המיקומים של קבוצת המעון באפליקציה (0 = מקום אחר במעון)
  let maonLoc = null;
  if (maon) {
    const locs = ((await loadKey(KEYS.locations, [])) || []).filter((l) => l && l.name && /מעון/.test(String(l.group || "")));
    if (locs.length) {
      const c = lastVal(q, "MClass");
      const n = c.val && /^\d+$/.test(c.val) ? Number(c.val) : -1;
      if (n < 0 || n > locs.length) {
        if (hung) return "noop=hangup";
        if (c.idx >= 2) return end("לא נבחרה כיתה", "להתראות");
        const digits = String(locs.length).length;
        const opts = locs.map((l, i) => `ל${String(l.name).replace(/[()]/g, " ")} הקישו ${i + 1}`);
        return ask(say(c.idx < 0 ? `שלום ${maon.name || ""}` : "", c.val ? "הבחירה לא קיימת" : "", "דיווח תקלה במעון", ...opts, "למקום אחר במעון הקישו 0", digits > 1 ? "ולאחר מכן סולמית" : ""),
          c.nextName, { max: digits, timeout: 15, allowed: digits > 1 ? "" : "0123456789".slice(0, locs.length + 1) });
      }
      maonLoc = n === 0 ? null : locs[n - 1];
      if (maonLoc) maonLoc = { id: maonLoc.id, name: maonLoc.name, group: maonLoc.group, label: `${maonLoc.group || "מעון"} · ${maonLoc.name}` };
    }
  }

  // הקלטת התקלה – נשמרת בימות, ואז מתומללת בג'מיני
  const rec = lastVal(q, "Rec");
  const file = recFile(q, "T", 0);
  if (noRec(rec.val)) {
    if (hung) return "noop=hangup";
    if (rec.idx >= 1) return end("לא התקבלה הקלטה", "להתראות");
    // 1 שם, 2 לא להשתמש בקודם, 3 הקלטה, 4 תיקייה, 5 שם קובץ, 6 אישור מיידי בסולמית, 7 לשמור גם בניתוק, 8 לא לשרשר, 9 מינימום שניות, 10 מקסימום
    const intro = maon
      ? (maonLoc
        ? [maonLoc.name.replace(/[()]/g, " "), "לאחר הצליל ספרו מה התקלה ובסיום הקישו סולמית"]
        : [rec.idx < 0 && lastVal(q, "MClass").idx < 0 ? `שלום ${maon.name || ""}` : "", "דיווח תקלה במעון", "לאחר הצליל ספרו מה התקלה ובסיום הקישו סולמית"])
      : [limited ? "שימו לב אפשר לדווח על תקלה אחת בשבוע" : "", "לאחר הצליל ספרו מה התקלה", "אם היא בחדר אמרו גם את מספר החדר", "ובסיום הקישו סולמית"];
    return `read=${say(...intro)}=${rec.nextName},no,record,${extPath(q)},${file},no,yes,no,1,90`;
  }
  const recPath = recPathOf(q, rec.val, file);

  // פתיחת המשימה (בלי כפילות אם ימות שולח שוב את אותה בקשה)
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  if (!callId || !tasks.some((t) => t && t.ivrCallId === callId)) {
    const { text: raw, err } = await transcribe(recPath, maon ? MAON_PROMPT : FAULT_PROMPT);
    if (err) console.error("transcribe:", err, recPath);
    // ג'מיני מחזיר "חדר: <מספר או ריק>" ובשורה הבאה "תקלה: <תיאור>"
    const mRoom = String(raw || "").match(/חדר\s*:\s*(\d{1,4})/);
    const mText = String(raw || "").match(/תקלה\s*:\s*([\s\S]*)/);
    let text = (mText ? mText[1] : raw || "").replace(/\s+/g, " ").trim();
    if (text === "ריק") text = "";
    const said = mRoom && !maon ? String(Number(mRoom[1])) : "";
    const room = said && (roomNums.size === 0 || roomNums.has(said)) ? said : "";
    // מספר שנאמר אבל לא קיים ברשימת החדרים – נשאר בתיאור ולא נרשם כחדר
    if (said && !room && text && !text.includes(said)) text += ` (נאמר חדר ${said})`;
    const short = text ? text.split(" ").slice(0, 6).join(" ") : "תקלה (הקלטה)";
    const title = maonLoc ? `${maonLoc.name} · ${short}` : maon ? `מעון · ${short}` : room ? `חדר ${room} · ${short}` : short;
    const reporter = callerName || `טלפון ${phone}`;
    const task = {
      id: genId(),
      title,
      description: `${text || `לא הצלחנו לתמלל את ההקלטה (${err}). לשמיעה: בקו, שלוחת התקלות, הקשה 4.`}\n\nדווח בטלפון ע"י ${reporter}${phone ? ` (${phone})` : ""}`,
      assignedToId: "",
      priority: "normal",
      location: maonLoc ? maonLoc.label : maon ? "מעון" : room ? `חדר ${room}` : "",
      locationId: maonLoc ? maonLoc.id : "",
      categoryId: "",
      status: "open",
      createdAt: Date.now(),
      createdBy: reporter,
      createdById: staff ? staff.id : undefined,
      comments: [],
      source: "ivr",
      reporterPhone: phone,
      ivrCallId: callId,
      ivrRecording: recPath,
    };
    // קודם המשימה עצמה – ורק אחר כך שאר הרישומים
    const fresh = (await loadKey(KEYS.tasks, [])) || [];
    if (!callId || !fresh.some((t) => t && t.ivrCallId === callId)) {
      // מספר רץ למשימה – כמו באפליקציה (הבא אחרי הגבוה ביותר)
      task.num = fresh.reduce((m, t) => Math.max(m, Number(t && t.num) || 0), 0) + 1;
      await saveKey(KEYS.tasks, [task, ...fresh]);
      try {
        const weekLog = (await loadKey(KEYS.ivrReports, [])) || [];
        const keep = weekLog.filter((e) => e && Date.now() - (e.at || 0) < 21 * 86400000);
        await saveKey(KEYS.ivrReports, [{ phone, at: task.createdAt, callId, taskId: task.id }, ...keep]);
      } catch (e) { console.error("report log", e); }
      await notifyManagers(profiles, `☎️ דיווח טלפוני מ${reporter} (#${task.num}): ${title}`, { tab: "tasks", taskId: task.id }, `/?tab=tasks&taskId=${task.id}&org=${ORG}`);
    }
  }
  return hung ? "noop=hangup" : end("התקלה נקלטה ותטופל בעזרת השם", "תודה ולהתראות");
}

async function notifyManagers(profiles, message, link, url) {
  const managers = profiles.filter((p) => p.role === "manager");
  if (!managers.length) return;
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
      body: JSON.stringify({ userIds: managers.map((m) => m.id), title: "ישיבוס", body: message, url }),
    });
  } catch (e) { console.error("push", e); }
}

/* ---------- 3: סטטוס ---------- */
async function status(phone) {
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  const mine = tasks
    .filter((t) => t && t.source === "ivr" && t.reporterPhone === phone)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 3);
  if (!mine.length) return end("לא נמצאו תקלות שדיווחתם מהטלפון הזה", "להתראות");
  const lines = mine.map((t) => `${String(t.title || "תקלה").split(" · ").pop()}${t.location ? ` ב${t.location}` : ""}, דווחה ${ago(t.createdAt)}: ${STATUS_TXT[t.status] || "ממתינה לטיפול"}`);
  return end(...lines, "להתראות");
}

/* ---------- 2: אחראי חדרים (עם קוד) ---------- */
function roomSpace(rooms, students) {
  const count = new Map();
  students.forEach((s) => { if (s.room != null && s.room !== "") count.set(Number(s.room), (count.get(Number(s.room)) || 0) + 1); });
  return rooms.filter(Boolean).map((r) => {
    const used = count.get(Number(r.num)) || 0;
    const beds = Number(r.beds) || 0;
    return { num: Number(r.num), beds, used, left: beds - used };
  });
}
const bedsTxt = (n) => (n === 1 ? "מיטה פנויה אחת" : `${n} מיטות פנויות`);

async function roomsMenu(q, { phone, students, profiles, auth, staff, roomMgr, callerName }) {
  const hung = q.hangup === "yes";
  const people = (auth || []).filter((a) => a && a.active !== false && a.code);
  if (!people.length) return end("עדיין לא הוגדרו אחראי חדרים", "להתראות");

  // קוד אישי
  const c = lastVal(q, "Code");
  const who = c.val ? people.find((a) => String(a.code) === c.val) : null;
  if (!who) {
    if (hung) return "noop=hangup";
    const callId = String(q.ApiCallId || "");
    if (c.val) await logIvr({ action: "badcode", callerPhone: phone, callId, dedupe: `${callId}:code${c.idx}` });
    // חסימה זמנית אחרי הרבה ניסיונות שגויים מאותו מספר
    const log = (await loadKey(KEYS.ivrLog, [])) || [];
    const recentBad = log.filter((e) => e && e.action === "badcode" && (e.callerPhone || "") === phone && Date.now() - e.at < 30 * 60000).length;
    if (recentBad >= 6) return end("יותר מדי ניסיונות שגויים", "נסו שוב בעוד חצי שעה", "להתראות");
    if (c.idx >= 2) return end("הקוד שגוי", "להתראות");
    const hi = !c.val && roomMgr ? `שלום ${roomMgr.name || ""}` : "";
    return ask(say(hi, c.val ? "הקוד שגוי" : "", "הקישו את הקוד ולאחריו סולמית"), c.nextName, { max: 6, min: 4, timeout: 15 });
  }

  const rooms = (await loadKey(KEYS.dormRooms, [])) || [];
  const m = lastVal(q, "RMenu");
  if (m.val === "2") return assign(q, { phone, students, profiles, rooms, who });
  // אחראי חדרים מדווח תקלה / שומע תקלות פתוחות מתוך תפריט החדרים
  if (m.val === "3") return report(q, { phone, staff, roomMgr: roomMgr || who, callerName: callerName || who.name, profiles });
  if (m.val === "4" && staff) return hung ? "noop=hangup" : playOpen();
  if (hung) return "noop=hangup";
  if (m.idx >= 5) return end("להתראות");
  if (m.val === "1") {
    const free = roomSpace(rooms, students).filter((r) => r.left > 0).sort((a, b) => b.left - a.left || a.num - b.num);
    const total = free.reduce((n, r) => n + r.left, 0);
    const lines = !free.length ? ["אין כרגע מיטות פנויות"] : [
      `יש ${total === 1 ? "מיטה פנויה אחת" : `${total} מיטות פנויות`} ב${free.length === 1 ? "חדר אחד" : `${free.length} חדרים`}`,
      ...free.slice(0, 6).map((r) => `חדר ${r.num} ${r.used === 0 ? "ריק" : ""} ${bedsTxt(r.left)}`),
      free.length > 6 ? `ועוד ${free.length - 6} חדרים` : "",
    ];
    return ask(say(...lines, "לשיבוץ בחור הקישו 2", "לשמיעה חוזרת הקישו 1"), m.nextName, { allowed: "12", timeout: 15 });
  }
  const keys = staff ? "1234" : "123";
  return ask(say("לחדרים פנויים הקישו 1", "לשיבוץ בחור הקישו 2", "לדיווח תקלה הקישו 3", staff ? "לתקלות הפתוחות הקישו 4" : ""), m.nextName, { allowed: keys });
}

/** שיבוץ בחור: חדר ← טלפון הבחור (אם הוא כבר ברשימה) או הקלטת השם ← אישור ← שמירה */
async function assign(q, { phone, students, profiles, rooms, who }) {
  const hung = q.hangup === "yes";
  const space = roomSpace(rooms, students);

  // חדר
  const r = lastVal(q, "ARoom");
  const rs = r.val && /^\d+$/.test(r.val) ? space.find((x) => x.num === Number(r.val)) : null;
  if (!rs || rs.left <= 0) {
    if (hung) return "noop=hangup";
    if (r.idx >= 2) return end("לא נבחר חדר עם מיטה פנויה", "להתראות");
    const why = !r.val ? "" : !rs ? `חדר ${r.val} לא קיים` : `חדר ${rs.num} מלא`;
    return ask(say(why, "הקישו מספר חדר ולאחריו סולמית"), r.nextName, { max: 4, timeout: 15 });
  }
  const room = rs.num;

  // טלפון הבחור – כדי למצוא אותו אם הוא כבר ברשימה (וגם כדי לזהות אותו בדיווח תקלות)
  const p = lastVal(q, "APhone");
  let sPhone = p.val ? normPhone(p.val) : "";
  if (!p.val || (sPhone !== "0" && sPhone.length < 9 && p.idx < 1)) {
    if (hung) return "noop=hangup";
    return ask(say(p.val ? "המספר לא תקין" : `חדר ${room} ${bedsTxt(rs.left)}`,
      "הקישו את הטלפון של הבחור ולאחריו סולמית", "אם אין טלפון הקישו אפס וסולמית"), p.nextName, { max: 10, timeout: 20 });
  }
  if (sPhone.length < 9) sPhone = "";

  let target = sPhone ? students.find((s) => normPhone(s.phone) === sPhone) : null;
  let name = target ? target.name : "";
  let recPath = "";
  let tag = "P";

  if (!target) {
    // שם הבחור בהקלטה, ותמלול בג'מיני
    const n = lastVal(q, "AName");
    const file = recFile(q, "N", Math.max(0, n.idx));
    const recordName = (pre) => `read=${say(pre, "אחרי הצליל אמרו את שם הבחור ובסיום הקישו סולמית")}=${n.idx < 0 ? "AName" : `AName_${n.idx + 1}`},no,record,${extPath(q)},${recFile(q, "N", n.idx + 1)},no,yes,no,1,20`;
    if (noRec(n.val)) {
      if (hung) return "noop=hangup";
      if (n.idx >= 3) return end("לא התקבלה הקלטה", "להתראות");
      return recordName(n.idx < 0 && sPhone ? "המספר לא נמצא ברשימת הבחורים" : "");
    }
    recPath = recPathOf(q, n.val, file);
    const t = await cachedTranscribe(q, `AName${n.idx}`, recPath, namePrompt(students.map((s) => s.name).filter(Boolean).slice(0, 600)));
    name = String(t.text || "").replace(/[^א-ת\s'"׳״]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name || name === "ריק") {
      if (hung) return "noop=hangup";
      if (t.err) console.error("name transcribe:", t.err, recPath);
      if (n.idx >= 2) return end("לא הצלחנו לזהות את השם", "אפשר לשבץ את הבחור באפליקציה", "להתראות");
      return recordName("לא הצלחנו לזהות את השם");
    }
    tag = `N${n.idx}`;
    // השם כבר רשום? אז זה אותו בחור – מעבירים אותו במקום ליצור כפול
    target = students.find((s) => nameKey(s.name) === nameKey(name)) || null;
    if (!target) {
      const okName = `AOk${n.idx}`;
      const ok = q[okName] === undefined ? undefined : String(q[okName]).trim();
      if (ok !== "1") {
        if (hung) return "noop=hangup";
        if (ok === "2") {
          if (n.idx >= 3) return end("השיבוץ בוטל", "להתראות");
          return recordName("");
        }
        return ask(say(name, `לשיבוץ בחדר ${room} הקישו 1`, "להקלטה מחדש הקישו 2"), okName, { allowed: "12" });
      }
    }
  }

  if (target) {
    if (target.room != null && Number(target.room) === room) return end(`${target.name} כבר רשום בחדר ${room}`, "להתראות");
    const confName = `AConf${tag}`;
    const cv = q[confName] === undefined ? undefined : String(q[confName]).trim();
    if (cv !== "1") {
      if (hung) return "noop=hangup";
      if (cv === "2") return end("השיבוץ בוטל", "להתראות");
      const where = target.room ? `בחדר ${target.room}` : "ללא חדר";
      return ask(say(target.name, where, `${target.room ? "להעברה" : "לשיבוץ"} לחדר ${room} הקישו 1`, "לביטול הקישו 2"), confName, { allowed: "12" });
    }
  }
  if (hung) return "noop=hangup";

  return saveAssign(q, { phone, profiles, room, target, name, sPhone, recPath, who });
}

async function saveAssign(q, { phone, profiles, room, target, name, sPhone, recPath, who }) {
  const callId = String(q.ApiCallId || "");
  const log = (await loadKey(KEYS.ivrLog, [])) || [];
  const done = callId && log.find((e) => e && e.callId === callId && ["add", "move", "assign"].includes(e.action));
  if (done) return end(`${done.studentName} שובץ בחדר ${done.room}`, "תודה ולהתראות");

  // קריאה טרייה ובדיקה חוזרת שהמיטה עדיין פנויה
  const [raw, dels, rooms] = await Promise.all([loadKey(KEYS.dormStudents, []), loadKey(KEYS.dormDeletes, []), loadKey(KEYS.dormRooms, [])]);
  const gone = new Set(dels || []);
  const all = (raw || []).filter(Boolean);
  const live = all.filter((s) => !gone.has(s.id));
  const rs = roomSpace(rooms || [], live).find((x) => x.num === room);
  if (!rs || rs.left <= 0) return end(`חדר ${room} התמלא בינתיים`, "השיבוץ לא נשמר", "להתראות");

  const now = Date.now();
  const by = who.name || "אחראי חדרים";
  const base = { by, byId: who.id, at: now, callerPhone: phone, seen: false };
  let next, action, fromRoom = null, sid, sname;
  if (target) {
    const cur = live.find((s) => s.id === target.id);
    if (!cur) return end("הבחור לא נמצא ברשימה", "להתראות");
    fromRoom = cur.room != null && cur.room !== "" ? Number(cur.room) : null;
    action = fromRoom ? "move" : "assign";
    sid = cur.id; sname = cur.name;
    next = all.map((s) => (s.id === cur.id ? { ...s, room, phone: s.phone || sPhone, updatedAt: now, ivr: { ...base, action, fromRoom } } : s));
  } else {
    const dup = live.find((s) => nameKey(s.name) === nameKey(name));
    if (dup) return end(`${dup.name} כבר רשום`, "השיבוץ לא נשמר", "להתראות");
    action = "add";
    sid = uuid(); sname = name;
    next = [...all, { id: sid, name, room, shiur: "", phone: sPhone, notes: "", createdAt: now, updatedAt: now,
      ivr: { ...base, action, nameCheck: true, recording: recPath } }];
  }
  await saveKey(KEYS.dormStudents, next);
  await logIvr({ action, by, byId: who.id, callerPhone: phone, callId, room, fromRoom, studentId: sid, studentName: sname, studentPhone: sPhone, nameCheck: action === "add" });

  const verb = action === "move" ? `הועבר מחדר ${fromRoom} לחדר ${room}` : `שובץ בחדר ${room}`;
  await notifyManagers(profiles, `☎️ ${sname} ${verb} (בטלפון, ע"י ${by})`, { tab: "dorms" }, `/?tab=dorms&org=${ORG}`);
  return end(`${sname} ${verb}`, action === "add" ? "איות השם ייבדק במשרד" : "", "תודה ולהתראות");
}

/** לצוות: הקראת התקלות הפתוחות שדווחו בטלפון (ואם אין תמלול – השמעת ההקלטה) */
async function playOpen() {
  const tasks = (await loadKey(KEYS.tasks, [])) || [];
  const open = tasks
    .filter((t) => t && t.source === "ivr" && t.status !== "done")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 6);
  if (!open.length) return end("אין תקלות טלפוניות פתוחות", "להתראות");
  const parts = [];
  open.forEach((t) => {
    const desc = String(t.description || "").split("\n")[0];
    const transcribed = desc && !desc.startsWith("לא הצלחנו");
    parts.push("t-" + clean(`${t.location || "תקלה"} ${ago(t.createdAt)}${transcribed ? ": " + desc : ""}`));
    if (!transcribed && t.ivrRecording) parts.push("f-" + String(t.ivrRecording).replace(/\.wav$/, "").replace(/[^a-zA-Z0-9/_]/g, ""));
  });
  parts.push("t-" + clean("סוף הרשימה"));
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
