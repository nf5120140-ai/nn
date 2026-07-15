import React, { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

/* ---------- Design tokens ---------- */
const C = {
  ink: "#14213D",        // deep navy from the logo, used for text/header
  paper: "#F3F6FB",      // soft cool-blue white page background
  kraft: "#FFFFFF",      // card background
  kraftDark: "#DCE4F0",  // card border / subtle divider
  stamp: "#FF5A5F",      // coral-red for shortage/urgent
  mustard: "#FFB347",    // warm orange for tasks/warning
  sage: "#5CB85C",       // logo green for ok/success
  steel: "#5B6B85",      // secondary text, muted navy-grey
  accent: "#2E86C4",     // logo blue accent
  accent2: "#5CB85C",    // logo green accent (gradient end)
};
const RADIUS = "20px";

const CATEGORY_COLORS = [
  "#7C5CFC", "#FF7EB6", "#2EC4B6", "#FFB347", "#FF5A5F", "#4F86F7", "#38C172", "#F7B733",
];
function categoryColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Rubik:wght@500;700;900&family=Heebo:wght@300;400;500;700&display=swap');
.wh-display { font-family: 'Rubik', sans-serif; }
.wh-body { font-family: 'Heebo', sans-serif; }
`;

/* ---------- Storage helpers ---------- */
const KEYS = {
  users: "kitchen-users",
  products: "kitchen-products",
  tasks: "kitchen-tasks",
  settings: "kitchen-settings",
  notifications: "kitchen-notifications",
  menuItems: "kitchen-menu-items",
  weeklyMenu: "kitchen-weekly-menu",
  reminders: "kitchen-reminders",
  stockLog: "kitchen-stock-log",
  orderHistory: "kitchen-order-history",
  locations: "kitchen-locations",
  dishTypes: "kitchen-dish-types",
  taskCategories: "kitchen-task-categories",
  orderRequests: "kitchen-order-requests",
  unitRequests: "kitchen-unit-requests",
  unitTemplates: "kitchen-unit-templates",
};

const SETUP_SQL = `create table kv_store (
  key text not null,
  shared boolean not null default true,
  value jsonb not null,
  updated_at timestamptz default now(),
  primary key (key, shared)
);

alter table kv_store enable row level security;

create policy allow_all on kv_store for all using (true) with check (true);`;

const WEEK_DAYS = [
  ["sunday", "יום ראשון"],
  ["monday", "יום שני"],
  ["tuesday", "יום שלישי"],
  ["wednesday", "יום רביעי"],
  ["thursday", "יום חמישי"],
  ["friday", "יום שישי"],
  ["saturday", "שבת"],
];
function weekdayDateLabel(idx) {
  const now = new Date();
  const diff = idx - now.getDay();
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}
const MEAL_SLOTS = [
  ["lunch", "צהריים"],
  ["dinner", "ערב"],
];

/* ---------- Offline layer ----------
   Everything is mirrored into IndexedDB (not localStorage - photos would blow past
   the 5MB quota). Writes go to the cache first and are queued when there's no
   network, then flushed to Supabase automatically once we're back online.
   Conflict policy: last-write-wins per key, and a key with unflushed local changes
   is never overwritten by a remote read. */

const IDB_NAME = "kitchen-offline";
const IDB_STORE = "kv";
const DIRTY_KEYS_LS = "kitchen-dirty-keys";

let idbPromise = null;
function openIdb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

async function cacheGet(key) {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error("cacheGet failed", key, e);
    return undefined;
  }
}

async function cacheSet(key, value) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("cacheSet failed", key, e);
  }
}

/* The dirty list is tiny, so plain localStorage is fine and lets us read it synchronously. */
function getDirtyKeys() {
  try {
    return JSON.parse(localStorage.getItem(DIRTY_KEYS_LS) || "[]");
  } catch (e) {
    return [];
  }
}
function setDirtyKeys(keys) {
  try {
    localStorage.setItem(DIRTY_KEYS_LS, JSON.stringify(keys));
  } catch (e) {}
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("kitchen-sync-changed", { detail: keys.length }));
  }
}
function markDirty(key) {
  const d = getDirtyKeys();
  if (!d.includes(key)) setDirtyKeys([...d, key]);
}
function clearDirty(key) {
  setDirtyKeys(getDirtyKeys().filter((k) => k !== key));
}

/* ---------- Roles & permissions ----------
   manager    - full access, the only role that can send an order to a supplier
   supervisor - "מנהל מטבח": sees exactly the tabs and admin screens the manager grants,
                and submits order requests for approval instead of sending them out
   worker     - tab-level permissions only */
const ROLES = [
  { id: "manager", label: "מנהל ראשי", desc: "גישה מלאה, מאשר הזמנות" },
  { id: "supervisor", label: "מנהל מטבח", desc: "גישה חלקית, שולח בקשות הזמנה לאישור" },
  { id: "staff", label: "עובד", desc: "גישה בסיסית לפי הרשאות" },
];
function roleLabel(role) {
  return ROLES.find((r) => r.id === role)?.label || "עובד";
}

/* Admin screens a supervisor can be granted. Managers always get all of them. */
const ADMIN_SECTIONS = [
  { id: "products", label: "מוצרים" },
  { id: "menu", label: "תפריט" },
  { id: "dishtypes", label: "סוגי מנות" },
  { id: "taskcats", label: "קטגוריות משימות" },
  { id: "locations", label: "מקומות" },
  { id: "reminders", label: "תזכורות" },
  { id: "analytics", label: "אנליטיקה" },
  { id: "orderrequests", label: "בקשות הזמנה" },
  { id: "unitrequests", label: "בקשות מהמחסן" },
  { id: "users", label: "עובדים" },
  { id: "settings", label: "הגדרות" },
];

/* New users start locked down: tasks only. The manager opens up whatever else they need
   per-user in the employees screen. */
const DEFAULT_PERMISSIONS = {
  inventory: false,
  order: false,
  tasks: true,
  unitRequest: false,
  taskScope: "own",            // "own" | "categories" | "all"
  visibleTaskCategories: [],   // used only when taskScope === "categories"
  admin: {},
};

/**
 * Which tasks may this user see? Managers see everything.
 * "own"        - only what's assigned to them (the default for a new worker)
 * "categories" - their own tasks, plus anything in the categories the manager opened
 * "all"        - everything
 */
function visibleTasksFor(user, tasks) {
  if (isManager(user)) return tasks;
  const perms = { ...DEFAULT_PERMISSIONS, ...(user?.permissions || {}) };
  const scope = perms.taskScope || "own";

  if (scope === "all") return tasks;

  if (scope === "categories") {
    const allowed = perms.visibleTaskCategories || [];
    return tasks.filter(
      (t) => t.assignedToId === user.id || (t.categoryId && allowed.includes(t.categoryId))
    );
  }

  return tasks.filter((t) => t.assignedToId === user.id);
}

/** A "unit" (e.g. the daycare) requests goods out of OUR stock, not from a supplier. */
function canRequestFromStock(user) {
  return isManager(user) || user?.permissions?.unitRequest === true;
}

const isManager = (u) => u?.role === "manager";
const isSupervisor = (u) => u?.role === "supervisor";

/** Can this user open a given admin screen? */
function canSeeAdminSection(user, sectionId) {
  if (isManager(user)) return true;
  if (!isSupervisor(user)) return false;
  return !!user?.permissions?.admin?.[sectionId];
}
/** Does this user have any admin screen at all (i.e. should the "ניהול" menu item show)? */
function hasAnyAdminSection(user) {
  if (isManager(user)) return true;
  if (!isSupervisor(user)) return false;
  return ADMIN_SECTIONS.some((s) => user?.permissions?.admin?.[s.id]);
}
/** Only a manager may push an order out to a supplier. Everyone else requests approval. */
function canSendOrders(user) {
  return isManager(user);
}

const isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

const PROFILE_CACHE_KEY = "kitchen-cached-profile";
function cachedProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function loadKey(key, fallback) {
  const cached = await cacheGet(key);

  // Local changes that haven't reached the server yet must win over whatever the
  // server still has, otherwise a refresh would silently discard the user's work.
  if (getDirtyKeys().includes(key)) {
    return cached !== undefined ? cached : fallback;
  }

  if (isOnline()) {
    try {
      const res = await window.storage.get(key, true);
      if (res) {
        const value = JSON.parse(res.value);
        await cacheSet(key, value);
        return value;
      }
      // Nothing on the server for this key.
      return cached !== undefined ? cached : fallback;
    } catch (e) {
      console.error("remote load failed, using cache", key, e);
    }
  }

  return cached !== undefined ? cached : fallback;
}

async function saveKey(key, value) {
  await cacheSet(key, value); // always land locally first, so nothing is ever lost

  if (!isOnline()) {
    markDirty(key);
    return { synced: false };
  }

  try {
    await window.storage.set(key, JSON.stringify(value), true);
    clearDirty(key);
    return { synced: true };
  } catch (e) {
    console.error("storage save failed, queued for sync", key, e);
    markDirty(key);
    return { synced: false };
  }
}

/** Push every queued key to the server. Re-reads the cache so the latest value wins. */
async function flushPendingWrites() {
  if (!isOnline()) return { flushed: 0, remaining: getDirtyKeys().length };

  const dirty = getDirtyKeys();
  let flushed = 0;

  for (const key of dirty) {
    const value = await cacheGet(key);
    if (value === undefined) {
      clearDirty(key);
      continue;
    }
    try {
      await window.storage.set(key, JSON.stringify(value), true);
      clearDirty(key);
      flushed++;
    } catch (e) {
      console.error("flush failed", key, e);
    }
  }

  return { flushed, remaining: getDirtyKeys().length };
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayStr = () => new Date().toLocaleDateString("he-IL");

/* ---------- Send channels (WhatsApp / SMS / Email) ---------- */
const CHANNELS = [
  { id: "whatsapp", label: "וואטסאפ", icon: "💬", color: "#25D366" },
  { id: "sms", label: "SMS", icon: "✉️", color: "#4F86F7" },
  { id: "email", label: "מייל", icon: "📧", color: "#EA4335" },
];
function channelMeta(id) {
  return CHANNELS.find((c) => c.id === id) || CHANNELS[0];
}

/** Normalize an Israeli/any phone to bare international digits (0501234567 -> 972501234567). */
function cleanPhoneDigits(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "972" + d.slice(1);
  return d;
}

/**
 * Open the given text in the chosen channel.
 * Returns { ok } or { ok:false, error } so callers can showToast the reason.
 */
function sendViaChannel(channel, { phone, email, text, subject }) {
  if (channel === "email") {
    const to = String(email || "").trim();
    if (!to) return { ok: false, error: "לא הוגדרה כתובת מייל ליעד הזה" };
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
      subject || ""
    )}&body=${encodeURIComponent(text)}`;
    return { ok: true };
  }
  if (channel === "sms") {
    const digits = cleanPhoneDigits(phone);
    if (!digits) return { ok: false, error: "לא הוגדר מספר טלפון ליעד הזה" };
    // "?&body=" is the form that works on both iOS and Android
    window.location.href = `sms:+${digits}?&body=${encodeURIComponent(text)}`;
    return { ok: true };
  }
  const digits = cleanPhoneDigits(phone);
  const url = digits
    ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
    : `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank");
  return { ok: true };
}

/** Small 3-way channel selector used in the order screen and the invite box. */
function ChannelPicker({ value, onChange, label = "שלח דרך" }) {
  return (
    <div>
      {label && (
        <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>
          {label}
        </label>
      )}
      <div className="flex gap-2">
        {CHANNELS.map((c) => {
          const active = value === c.id;
          return (
            <button
              key={c.id}
              onClick={() => onChange(c.id)}
              className="flex-1 py-2 rounded-2xl text-sm font-bold"
              style={{
                background: active ? c.color : "#fff",
                color: active ? "#fff" : c.color,
                border: `1.5px solid ${c.color}`,
              }}
            >
              {c.icon} {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Building / room locations ---------- */
function range(from, to) {
  const arr = [];
  for (let i = from; i <= to; i++) arr.push(String(i));
  return arr;
}
function buildDefaultLocations() {
  const groups = [
    { group: "בניין ישן - קומה 1", rooms: [...range(101, 113), "שירותים קומה 1", "מקלחות קומה 1"] },
    { group: "בניין ישן - קומה 2", rooms: [...range(201, 212), "שירותים קומה 2", "מקלחות קומה 2"] },
    { group: "בניין ישן - קומה 3", rooms: [...range(301, 313), "שירותים קומה 3", "מקלחות קומה 3"] },
    { group: "בניין ישן - קומה 4", rooms: [...range(401, 412), "שירותים קומה 4", "מקלחות קומה 4"] },
    { group: "בניין חדש - קומה 1", rooms: range(501, 509) },
    { group: "בניין חדש - קומה 2", rooms: range(601, 609) },
    { group: "בניין חדש - קומה 3", rooms: ["מרפסת", "חדר כביסה"] },
    { group: "דירות רבנים", rooms: ["דירת רבנים חדשה - ימין", "דירת רבנים חדשה - שמאל", "דירת רבנים ישנה"] },
    {
      group: "בית מדרש",
      rooms: [
        "בית מדרש",
        ...range(1, 5).map((n) => `שירותים בית מדרש - ימין ${n}`),
        ...range(1, 5).map((n) => `שירותים בית מדרש - שמאל ${n}`),
      ],
    },
    { group: "מטבחים וחדרי אוכל", rooms: ["מטבח בשרי", "מטבח חלבי", "חדר אוכל גדול", "חדר אוכל רבנים", "חדר אוכל קטן"] },
    {
      group: "מעון ילדים",
      rooms: [
        "כיתת תינוקות - ימין (חדר כחול)",
        "כיתת פעוטות - שמאל (חדר ורוד)",
        "כיתת בוגרים - למעלה (חדר ירוק)",
        "כיתת תינוקות - קומה מינוס (חדר סגול)",
        "מטבח מעון",
      ],
    },
  ];
  const flat = [];
  groups.forEach((g) => {
    g.rooms.forEach((r) => flat.push({ id: genId(), name: r, group: g.group, imageData: null }));
  });
  return flat;
}

/* ---------- Shelf-tag card (signature element) ---------- */
function ShelfTag({ children, accent = C.steel, style = {} }) {
  return (
    <div
      className="relative wh-body"
      style={{
        background: C.kraft,
        borderRadius: RADIUS,
        border: `1px solid ${C.kraftDark}`,
        boxShadow: "0 4px 16px rgba(124,92,252,0.08)",
        padding: "16px 18px 16px 18px",
        borderRight: `5px solid ${accent}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------- Barcode Scanner ---------- */
const QUAGGA_SRC = "https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js";
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      if (window.Quagga) return resolve();
      // script tag exists but may still be loading
      const check = setInterval(() => {
        if (window.Quagga) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("script load failed"));
    document.head.appendChild(s);
  });
}

function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const quaggaTargetRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [mode, setMode] = useState("loading"); // loading | native | quagga | manual
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const detectedRef = useRef(false);

  const finish = useCallback((code) => {
    if (detectedRef.current) return;
    detectedRef.current = true;
    onDetected(code);
  }, [onDetected]);

  useEffect(() => {
    let cancelled = false;

    function stopStream() {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    }

    async function nativeDetectorAvailable() {
      if (!("BarcodeDetector" in window)) return false;
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        return supported && supported.length > 0 ? supported : false;
      } catch (e) {
        console.error("BarcodeDetector.getSupportedFormats failed:", e);
        return false;
      }
    }

    async function startNative(supportedFormats) {
      const wanted = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];
      const formats = wanted.filter((f) => supportedFormats.includes(f));
      if (formats.length === 0) throw new Error("No overlapping supported barcode formats");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new window.BarcodeDetector({ formats });
      const scanLoop = async () => {
        if (cancelled || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          if (codes && codes.length > 0) { finish(codes[0].rawValue); return; }
        } catch (e) { /* ignore per-frame errors */ }
        rafRef.current = requestAnimationFrame(scanLoop);
      };
      scanLoop();
    }

    async function startQuagga() {
      await loadScriptOnce(QUAGGA_SRC);
      if (cancelled || !window.Quagga || !quaggaTargetRef.current) throw new Error("Quagga failed to load or mount point missing");
      await new Promise((resolve, reject) => {
        window.Quagga.init(
          {
            inputStream: {
              type: "LiveStream",
              target: quaggaTargetRef.current,
              constraints: { facingMode: "environment", width: { min: 480 }, height: { min: 480 } },
            },
            locator: { patchSize: "medium", halfSample: true },
            numOfWorkers: 2,
            frequency: 10,
            decoder: { readers: ["ean_reader", "ean_8_reader", "code_128_reader", "upc_reader", "codabar_reader"] },
            locate: true,
          },
          (err) => {
            if (cancelled) return resolve();
            if (err) { reject(err); return; }
            window.Quagga.start();
            resolve();
          }
        );
      });
      window.Quagga.onDetected((result) => {
        if (result && result.codeResult && result.codeResult.code) {
          finish(result.codeResult.code);
        }
      });
    }

    async function start() {
      const supportedFormats = await nativeDetectorAvailable();
      if (supportedFormats) {
        try {
          await startNative(supportedFormats);
          if (!cancelled) { setMode("native"); return; }
        } catch (e) {
          console.error("Native barcode scan failed:", e);
          stopStream();
        }
      }
      try {
        setMode("quagga");
        await startQuagga();
      } catch (e) {
        console.error("Quagga scan failed:", e);
        setError("לא ניתן להפעיל סריקת מצלמה במכשיר/דפדפן הזה. הזן ברקוד ידנית. (פרטים טכניים בקונסול)");
        setMode("manual");
      }
    }
    start();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stopStream();
      if (window.Quagga && window.Quagga.stop) {
        try { window.Quagga.stop(); } catch (e) {}
      }
    };
  }, [finish]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col wh-body" style={{ background: "rgba(31,42,36,0.92)" }}>
      <div className="flex items-center justify-between p-4">
        <span className="wh-display text-lg font-bold" style={{ color: C.paper }}>
          סריקת ברקוד
        </span>
        <button onClick={onClose} className="px-3 py-1 rounded-2xl" style={{ background: C.paper, color: C.ink }}>
          סגור
        </button>
      </div>

      {mode === "loading" && (
        <div className="flex-1 flex items-center justify-center">
          <p style={{ color: C.paper }} className="text-sm">מפעיל מצלמה...</p>
        </div>
      )}

      {mode === "native" && (
        <div className="flex-1 flex items-center justify-center px-4">
          <video ref={videoRef} className="rounded-lg w-full max-w-sm" muted playsInline />
        </div>
      )}

      <div
        ref={quaggaTargetRef}
        className="flex-1 flex items-center justify-center px-4"
        style={{ display: mode === "quagga" ? "flex" : "none" }}
      />

      {mode === "manual" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
          {error && <p style={{ color: C.paper }} className="text-center text-sm">{error}</p>}
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="הזן מספר ברקוד"
            className="w-full max-w-xs p-3 rounded-2xl text-lg text-center"
            style={{ direction: "ltr" }}
            autoFocus
          />
          <button
            onClick={() => manual.trim() && finish(manual.trim())}
            className="px-6 py-2 rounded-2xl font-bold wh-display"
            style={{ background: C.mustard, color: C.ink }}
          >
            אישור
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Organization Gate ---------- */
/* ---------- Biometric device lock (WebAuthn) ---------- */
const BIOMETRIC_ENABLED_KEY = "warehouse-app-biometric-enabled";
const BIOMETRIC_CRED_KEY = "warehouse-app-biometric-cred-id";

function isBiometricEnabled() {
  try {
    return localStorage.getItem(BIOMETRIC_ENABLED_KEY) === "true";
  } catch (e) {
    return false;
  }
}

async function isBiometricSupported() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    return false;
  }
}

async function registerBiometric(displayName) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const publicKey = {
    challenge,
    rp: { name: "ניהול משימות ומלאי מוסדי" },
    user: { id: userId, name: displayName || "user", displayName: displayName || "user" },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
    timeout: 60000,
    attestation: "none",
  };
  const cred = await navigator.credentials.create({ publicKey });
  const rawIdBytes = new Uint8Array(cred.rawId);
  let binary = "";
  rawIdBytes.forEach((b) => (binary += String.fromCharCode(b)));
  const credId = btoa(binary);
  localStorage.setItem(BIOMETRIC_CRED_KEY, credId);
  localStorage.setItem(BIOMETRIC_ENABLED_KEY, "true");
}

async function verifyBiometric() {
  const credId = localStorage.getItem(BIOMETRIC_CRED_KEY);
  if (!credId) return false;
  const binary = atob(credId);
  const rawId = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) rawId[i] = binary.charCodeAt(i);
  const publicKey = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ id: rawId, type: "public-key" }],
    userVerification: "required",
    timeout: 60000,
  };
  try {
    await navigator.credentials.get({ publicKey });
    return true;
  } catch (e) {
    return false;
  }
}

function disableBiometric() {
  localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
  localStorage.removeItem(BIOMETRIC_CRED_KEY);
}

/* ---------- OS-level notifications ---------- */
const NOTIF_PROMPTED_KEY = "warehouse-app-notif-prompted";

function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}
function notificationPermission() {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}
async function requestNotificationPermission() {
  if (!notificationsSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch (e) {
    console.error("Notification.requestPermission failed", e);
    return "denied";
  }
}
function hasPromptedNotifications() {
  try {
    return localStorage.getItem(NOTIF_PROMPTED_KEY) === "true";
  } catch (e) {
    return true;
  }
}
function markPromptedNotifications() {
  try {
    localStorage.setItem(NOTIF_PROMPTED_KEY, "true");
  } catch (e) {}
}

/**
 * Show a system notification.
 * On Android Chrome `new Notification()` throws ("Illegal constructor"), so we must
 * go through the service worker registration when one is available.
 */
async function showOsNotification(title, body, tag) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  const options = {
    body,
    icon: "/icon-192-v2.png",
    badge: "/icon-192-v2.png",
    tag: tag || undefined,
    dir: "rtl",
    lang: "he",
    vibrate: [200, 100, 200],
  };
  try {
    const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && typeof reg.showNotification === "function") {
      await reg.showNotification(title, options);
      return;
    }
    new Notification(title, options);
  } catch (e) {
    console.error("showOsNotification failed", e);
  }
}

/** Ask for permission, then register this device with the push server.
    Returns the permission result. */
async function enablePushOnThisDevice() {
  const result = await requestNotificationPermission();
  markPromptedNotifications();
  if (result !== "granted") return result;
  try {
    if (window.auth?.registerPush) await window.auth.registerPush();
  } catch (e) {
    // Permission is granted, so in-app + foreground notifications still work.
    // Only true background push is unavailable (e.g. VAPID key not configured yet).
    console.error("push registration failed", e);
  }
  return result;
}

function NotificationsToggle({ showToast }) {
  const [perm, setPerm] = useState(() => notificationPermission());

  if (perm === "unsupported") return null;

  async function enable() {
    const result = await enablePushOnThisDevice();
    setPerm(result);
    if (result === "granted") {
      showToast("התראות הופעלו במכשיר הזה");
      showOsNotification("ההתראות פעילות ✓", "תקבל התראה גם כשהאפליקציה סגורה.", "test");
    } else if (result === "denied") {
      showToast("ההתראות חסומות - יש לאפשר אותן בהגדרות הדפדפן/האפליקציה");
    }
  }

  if (perm === "granted") {
    return (
      <div
        className="mx-3 mb-2 py-2 rounded-2xl font-bold text-sm text-center"
        style={{ background: C.sage, color: "#fff" }}
      >
        🔔 התראות פעילות במכשיר הזה
      </div>
    );
  }

  if (perm === "denied") {
    return (
      <div
        className="mx-3 mb-2 py-2 px-3 rounded-2xl text-xs text-center"
        style={{ background: C.kraft, color: C.steel, border: `1px solid ${C.kraftDark}` }}
      >
        🔕 ההתראות חסומות. כדי להפעיל: הגדרות הדפדפן ← הרשאות אתר ← התראות.
      </div>
    );
  }

  return (
    <button
      onClick={enable}
      className="mx-3 mb-2 py-2 rounded-2xl font-bold text-sm text-center"
      style={{ background: C.paper, color: C.ink, border: `1px solid ${C.kraftDark}` }}
    >
      🔔 הפעל התראות למכשיר הזה
    </button>
  );
}

const BIOMETRIC_PROMPTED_KEY = "warehouse-app-biometric-prompted";function hasPromptedBiometric() {
  try {
    return localStorage.getItem(BIOMETRIC_PROMPTED_KEY) === "true";
  } catch (e) {
    return true;
  }
}
function markPromptedBiometric() {
  try {
    localStorage.setItem(BIOMETRIC_PROMPTED_KEY, "true");
  } catch (e) {}
}

const HAS_ACCOUNT_KEY = "warehouse-app-has-account";
function hasExistingAccount() {
  try {
    return localStorage.getItem(HAS_ACCOUNT_KEY) === "true";
  } catch (e) {
    return false;
  }
}
function markHasAccount() {
  try {
    localStorage.setItem(HAS_ACCOUNT_KEY, "true");
  } catch (e) {}
}

function BiometricToggle({ currentUser, showToast }) {
  const [enabled, setEnabled] = useState(() => isBiometricEnabled());
  const [supported, setSupported] = useState(null); // null = checking
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    isBiometricSupported().then(setSupported);
  }, []);

  async function toggle() {
    if (enabled) {
      disableBiometric();
      setEnabled(false);
      showToast("נעילת טביעת אצבע בוטלה במכשיר הזה");
      return;
    }
    setBusy(true);
    try {
      await registerBiometric(currentUser.name);
      setEnabled(true);
      showToast("נעילת טביעת אצבע הופעלה למכשיר הזה");
    } catch (e) {
      showToast("לא ניתן היה להפעיל טביעת אצבע במכשיר הזה");
    } finally {
      setBusy(false);
    }
  }

  if (supported === false) return null;

  return (
    <button
      onClick={toggle}
      disabled={busy || supported === null}
      className="mx-3 mb-2 py-2 rounded-2xl font-bold text-sm text-center"
      style={{ background: enabled ? C.sage : C.paper, color: enabled ? "#fff" : C.ink, border: `1px solid ${C.kraftDark}` }}
    >
      {busy ? "..." : enabled ? "✓ נעילת טביעת אצבע פעילה (לחץ לביטול)" : "👆 הפעל נעילת טביעת אצבע למכשיר הזה"}
    </button>
  );
}

function LockScreen({ onUnlock, onUseLogout }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function tryUnlock() {
    setErr("");
    setBusy(true);
    try {
      const ok = await verifyBiometric();
      if (ok) onUnlock();
      else setErr("האימות נכשל, נסה שוב");
    } catch (e) {
      setErr("האימות נכשל, נסה שוב");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    tryUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center wh-body" style={{ background: C.paper }} dir="rtl">
      <style>{FONTS}</style>
      <div className="w-full max-w-xs text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="wh-display text-xl font-black mb-2" style={{ color: C.ink }}>נעול</h1>
        <p className="text-sm mb-6" style={{ color: C.steel }}>אמת עם טביעת אצבע כדי להיכנס</p>
        {err && <p className="text-sm mb-3" style={{ color: C.stamp }}>{err}</p>}
        <button
          onClick={tryUnlock}
          disabled={busy}
          className="w-full p-3 rounded-2xl font-bold wh-display mb-3"
          style={{ background: C.ink, color: C.paper }}
        >
          {busy ? "מאמת..." : "👆 אמת עם טביעת אצבע"}
        </button>
        <button onClick={onUseLogout} className="text-xs underline" style={{ color: C.accent }}>
          לא ניתן לאמת? התחבר מחדש עם מייל וסיסמה
        </button>
      </div>
    </div>
  );
}

function SetNewPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function save() {
    if (password.length < 6) {
      setErr("הסיסמה חייבת להיות לפחות 6 תווים");
      return;
    }
    if (password !== confirm) {
      setErr("הסיסמאות לא תואמות");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      await window.auth.updatePassword(password);
      setDone(true);
      window.location.hash = "";
      await window.auth.signOut();
    } catch (e) {
      setErr(e?.message || "שגיאה בעדכון הסיסמה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center wh-body" style={{ background: C.paper }} dir="rtl">
      <style>{FONTS}</style>
      <div className="w-full max-w-xs">
        <h1 className="wh-display text-xl font-black mb-4 text-center" style={{ color: C.ink }}>קביעת סיסמה חדשה</h1>
        {done ? (
          <ShelfTag accent={C.sage} style={{ textAlign: "center" }}>
            <p className="text-sm mb-3" style={{ color: C.ink }}>הסיסמה עודכנה בהצלחה!</p>
            <button onClick={onDone} className="w-full p-3 rounded-2xl font-bold wh-display" style={{ background: C.ink, color: C.paper }}>
              עבור להתחברות
            </button>
          </ShelfTag>
        ) : (
          <ShelfTag accent={C.ink} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="סיסמה חדשה" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} autoFocus />
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" placeholder="אימות סיסמה" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
            <button onClick={save} disabled={busy} className="p-3 rounded-2xl font-bold wh-display" style={{ background: C.ink, color: C.paper }}>
              {busy ? "מעדכן..." : "שמור סיסמה חדשה"}
            </button>
          </ShelfTag>
        )}
      </div>
    </div>
  );
}

/** An invite link looks like https://site/?join=<orgId> - pull the code out of it. */
function orgIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("join") || "";
  } catch (e) {
    return "";
  }
}

function AuthGate({ onAuthed }) {
  const invitedOrgId = orgIdFromUrl();
  const [mode, setMode] = useState(() => {
    if (invitedOrgId) return "join"; // arrived via an invite link
    return hasExistingAccount() ? "login" : "choose";
  });
  const [showTerms, setShowTerms] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [orgName, setOrgName] = useState("");
  const [joinOrgId, setJoinOrgId] = useState(invitedOrgId);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmNotice, setConfirmNotice] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  async function doResetPassword() {
    if (!email.trim()) {
      setErr("הזן את המייל שלך למעלה קודם, ואז לחץ שוב על 'שכחת סיסמה'");
      return;
    }
    setErr("");
    setResetBusy(true);
    try {
      await window.auth.resetPasswordForEmail(email.trim());
      setResetSent(true);
    } catch (e) {
      setErr(e?.message || "שגיאה בשליחת המייל");
    } finally {
      setResetBusy(false);
    }
  }

  async function doCreate() {
    if (!email.trim() || !password.trim() || !orgName.trim() || !displayName.trim()) {
      setErr("יש למלא את כל השדות");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      const data = await window.auth.signUpCreateOrg({ email: email.trim(), password, orgName: orgName.trim(), displayName: displayName.trim(), phone: phone.trim() });
      markHasAccount();
      if (data?.session) onAuthed();
      else setConfirmNotice(true);
    } catch (e) {
      setErr(e?.message || "שגיאה בהרשמה");
    } finally {
      setBusy(false);
    }
  }

  async function doJoin() {
    if (!email.trim() || !password.trim() || !joinOrgId.trim() || !displayName.trim()) {
      setErr("יש למלא את כל השדות");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      const data = await window.auth.signUpJoinOrg({ email: email.trim(), password, orgId: joinOrgId.trim(), displayName: displayName.trim(), phone: phone.trim() });
      markHasAccount();
      if (data?.session) onAuthed();
      else setConfirmNotice(true);
    } catch (e) {
      setErr(e?.message || "שגיאה בהרשמה");
    } finally {
      setBusy(false);
    }
  }

  async function doLogin() {
    if (!email.trim() || !password.trim()) {
      setErr("יש להזין מייל וסיסמה");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      await window.auth.signIn(email.trim(), password);
      markHasAccount();
      onAuthed();
    } catch (e) {
      setErr(e?.message || "מייל או סיסמה שגויים");
    } finally {
      setBusy(false);
    }
  }

  if (confirmNotice) {
    return (
      <div className="min-h-screen flex items-center justify-center wh-body" style={{ background: C.paper }} dir="rtl">
        <style>{FONTS}</style>
        <div className="w-full max-w-xs text-center">
          <ShelfTag accent={C.sage}>
            <p className="font-bold mb-2" style={{ color: C.ink }}>נשלח מייל אימות</p>
            <p className="text-sm" style={{ color: C.steel }}>
              בדוק את תיבת הדואר שלך ({email}) ולחץ על הקישור לאימות, ואז חזור לכאן ותתחבר.
            </p>
          </ShelfTag>
          <button onClick={() => { setMode("login"); setConfirmNotice(false); }} className="mt-3 text-sm underline" style={{ color: C.accent }}>
            עבור להתחברות
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center wh-body py-8" style={{ background: C.paper, position: "relative" }} dir="rtl">
      <style>{FONTS}</style>
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: "url(/icon-512-v2.png)",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
          backgroundSize: "70vw",
          opacity: 0.06,
          pointerEvents: "none",
        }}
      />
      <div className="w-full max-w-xs" style={{ position: "relative" }}>
        <h1 className="wh-display text-2xl font-black mb-1 text-center" style={{ color: C.ink }}>
          ניהול משימות ומלאי מוסדי
        </h1>
        <p className="text-center text-sm mb-6" style={{ color: C.steel }}>
          כל ארגון מקבל מרחב נתונים נפרד ומאובטח משלו
        </p>

        {mode === "choose" && (
          <div className="flex flex-col gap-3">
            <button onClick={() => setMode("create")} className="p-4 rounded-2xl font-bold wh-display text-right" style={{ background: C.accent, color: "#fff" }}>
              🏢 צור ארגון חדש
              <div className="text-xs font-normal mt-1 opacity-90">אם זו הפעם הראשונה שלך כאן</div>
            </button>
            <button onClick={() => setMode("join")} className="p-4 rounded-2xl font-bold wh-display text-right" style={{ background: C.kraft, color: C.ink, border: `1.5px solid ${C.kraftDark}` }}>
              🔑 הצטרף לארגון קיים
              <div className="text-xs font-normal mt-1" style={{ color: C.steel }}>אם קיבלת קוד ארגון ממנהל</div>
            </button>
            <button onClick={() => setMode("login")} className="p-3 rounded-2xl font-bold text-sm text-center" style={{ background: "transparent", color: C.accent }}>
              כבר יש לי חשבון - התחבר
            </button>
          </div>
        )}

        {mode === "create" && (
          <ShelfTag accent={C.accent} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="שם הארגון/המטבח" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} autoFocus />
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="השם שלך" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון (אופציונלי)" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="מייל" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="סיסמה" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
            <button onClick={doCreate} disabled={busy} className="p-3 rounded-2xl font-bold wh-display" style={{ background: C.ink, color: C.paper }}>
              {busy ? "יוצר..." : "צור ארגון והירשם"}
            </button>
            <button onClick={() => setMode("choose")} className="text-xs" style={{ color: C.steel }}>חזרה</button>
          </ShelfTag>
        )}

        {mode === "join" && (
          <ShelfTag accent={C.sage} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {invitedOrgId ? (
              <div className="p-2 rounded-xl text-center" style={{ background: "#E8F6E8", border: `1px solid ${C.sage}` }}>
                <div className="text-sm font-bold" style={{ color: C.sage }}>✓ הוזמנת לארגון</div>
                <div className="text-xs" style={{ color: C.steel }}>קוד הארגון כבר מולא. רק מלא את הפרטים שלך למטה.</div>
              </div>
            ) : (
              <p className="text-xs" style={{ color: C.steel }}>בקש מהמנהל שלך את קוד/מזהה הארגון (Org ID) שיש לו במסך ניהול.</p>
            )}
            <input
              value={joinOrgId}
              onChange={(e) => setJoinOrgId(e.target.value)}
              placeholder="Org ID"
              className="p-3 rounded-2xl border"
              style={{
                borderColor: invitedOrgId ? C.sage : C.kraftDark,
                direction: "ltr",
                background: invitedOrgId ? "#F4FBF4" : "#fff",
              }}
              autoFocus={!invitedOrgId}
            />
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="השם שלך" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} autoFocus={!!invitedOrgId} />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון (אופציונלי)" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="מייל" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="סיסמה" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
            <button onClick={doJoin} disabled={busy} className="p-3 rounded-2xl font-bold wh-display" style={{ background: C.ink, color: C.paper }}>
              {busy ? "מצטרף..." : "הצטרף והירשם"}
            </button>
            <button onClick={() => setMode("login")} className="text-xs underline" style={{ color: C.accent }}>
              כבר יש לי חשבון - התחבר
            </button>
            <button onClick={() => setMode("choose")} className="text-xs" style={{ color: C.steel }}>חזרה</button>
          </ShelfTag>
        )}

        {mode === "login" && (
          <ShelfTag accent={C.ink} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="מייל" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} autoFocus />
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="סיסמה" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
            {resetSent && <p style={{ color: C.sage }} className="text-sm">נשלח מייל לאיפוס הסיסמה - בדוק את תיבת הדואר שלך.</p>}
            <button onClick={doLogin} disabled={busy} className="p-3 rounded-2xl font-bold wh-display" style={{ background: C.ink, color: C.paper }}>
              {busy ? "מתחבר..." : "התחבר"}
            </button>
            <button onClick={doResetPassword} disabled={resetBusy} className="text-xs underline" style={{ color: C.accent }}>
              {resetBusy ? "שולח..." : "שכחת סיסמה?"}
            </button>
            <button onClick={() => setMode("choose")} className="text-xs underline" style={{ color: C.accent }}>
              אין לי חשבון / רוצה לפתוח ארגון אחר
            </button>
          </ShelfTag>
        )}
        <p className="text-center text-xs mt-6" style={{ color: C.steel }}>
          © כל הזכויות שמורות לנפתלי קמפה · ת.ז. 313****31
        </p>
        <p className="text-center text-xs">
          <a
            href={`https://wa.me/972585120140?text=${encodeURIComponent("שלום, רציתי לפתח/להוסיף:")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
            style={{ color: C.accent }}
          >
            המלצות/פניות לפיתוח: 0585120140
          </a>
        </p>
        <div className="text-center mt-2">
          <button onClick={() => setShowTerms((v) => !v)} className="text-xs underline" style={{ color: C.accent }}>
            תנאי שימוש
          </button>
          {showTerms && (
            <div className="mt-2 p-3 rounded-2xl text-xs text-right" style={{ background: C.kraft, color: C.steel, border: `1px solid ${C.kraftDark}` }}>
              <p className="mb-1">האפליקציה נמצאת כרגע <b>בשלבי פיתוח</b> וניתנת לשימוש <b>ללא עלות בשלב זה</b>.</p>
              <p className="mb-1">ייתכנו שינויים, תקלות, ואי-זמינות זמנית תוך כדי הפיתוח. אין התחייבות לזמינות רציפה או לשמירת נתונים באופן מוחלט.</p>
              <p>השימוש באפליקציה הוא באחריות המשתמש. לשאלות או הצעות אפשר לפנות למספר שמופיע למעלה.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


/* ---------- Login ---------- */
function Login({ users, onLogin, onFirstRun, onDisconnect }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  function submit(e) {
    if (e) e.preventDefault();
    let finalName = name;
    let finalPassword = password;
    if (e?.target) {
      try {
        const fd = new FormData(e.target);
        finalName = (fd.get("username") || name || "").toString();
        finalPassword = (fd.get("password") || password || "").toString();
      } catch (err) {
        // fall back to React state if FormData isn't available
      }
    }
    const u = users.find((u) => u.name === finalName.trim() && u.password === finalPassword);
    if (!u) {
      setErr("שם משתמש או סיסמה שגויים");
      return;
    }
    setErr("");
    onLogin(u);
  }

  return (
    <div className="min-h-screen flex items-center justify-center wh-body" style={{ background: C.paper }} dir="rtl">
      <style>{FONTS}</style>
      <div className="w-full max-w-xs">
        <h1 className="wh-display text-2xl font-black mb-1 text-center" style={{ color: C.ink }}>
          ניהול משימות ומלאי מוסדי
        </h1>
        <p className="text-center text-sm mb-6" style={{ color: C.steel }}>
          כניסה למערכת ניהול המלאי
        </p>
        <form onSubmit={submit} autoComplete="on">
          <ShelfTag accent={C.sage} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="שם משתמש"
              name="username"
              autoComplete="username"
              className="p-3 rounded-2xl border"
              style={{ borderColor: C.kraftDark, background: C.paper }}
              autoFocus
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="סיסמה"
              name="password"
              autoComplete="current-password"
              className="p-3 rounded-2xl border"
              style={{ borderColor: C.kraftDark, background: C.paper }}
            />
            {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
            <button
              type="submit"
              className="p-3 rounded-2xl font-bold wh-display"
              style={{ background: C.ink, color: C.paper, cursor: "pointer" }}
            >
              כניסה
            </button>
          </ShelfTag>
        </form>
        {onFirstRun && (
          <p className="text-xs text-center mt-4" style={{ color: C.steel }}>
            משתמש ברירת מחדל: <b>מנהל</b> / סיסמה <b>1234</b> (ניתן לשנות בהגדרות לאחר הכניסה)
          </p>
        )}
        <p className="text-xs text-center mt-4" style={{ color: C.steel }}>
          <button onClick={onDisconnect} className="underline" style={{ color: C.accent }}>זה לא מסד הנתונים שלי / התחבר למסד אחר</button>
        </p>
      </div>
    </div>
  );
}

/* ---------- Offline / sync status bar ---------- */
function SyncBar({ showToast }) {
  const [online, setOnline] = useState(isOnline());
  const [pending, setPending] = useState(() => getDirtyKeys().length);
  const [syncing, setSyncing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);

  const doFlush = useCallback(async () => {
    if (!isOnline() || getDirtyKeys().length === 0) return;
    setSyncing(true);
    const { flushed, remaining } = await flushPendingWrites();
    setSyncing(false);
    setPending(remaining);
    if (flushed > 0 && remaining === 0) {
      setJustSynced(true);
      if (showToast) showToast("כל השינויים סונכרנו לשרת ✓");
      setTimeout(() => setJustSynced(false), 3000);
    }
  }, [showToast]);

  useEffect(() => {
    function onOnline() {
      setOnline(true);
      doFlush();
    }
    function onOffline() {
      setOnline(false);
    }
    function onSyncChanged(e) {
      setPending(e.detail);
    }

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("kitchen-sync-changed", onSyncChanged);

    // Catch anything left over from a previous session, and retry periodically in
    // case navigator.onLine lies (captive portals, flaky mobile data).
    doFlush();
    const interval = setInterval(doFlush, 20000);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("kitchen-sync-changed", onSyncChanged);
      clearInterval(interval);
    };
  }, [doFlush]);

  if (online && pending === 0 && !justSynced) return null;

  let bg = C.mustard;
  let label = "";

  if (!online) {
    bg = C.steel;
    label =
      pending > 0
        ? `📴 אין חיבור - ${pending} שינויים שמורים במכשיר ויסונכרנו אוטומטית`
        : "📴 אין חיבור - אפשר להמשיך לעבוד, הנתונים נשמרים במכשיר";
  } else if (syncing) {
    bg = C.accent;
    label = "🔄 מסנכרן...";
  } else if (pending > 0) {
    bg = C.mustard;
    label = `⏳ ${pending} שינויים ממתינים לסנכרון`;
  } else if (justSynced) {
    bg = C.sage;
    label = "✓ הכל מסונכרן";
  }

  return (
    <button
      onClick={doFlush}
      className="w-full py-1.5 px-3 text-xs font-bold wh-body text-center"
      style={{ background: bg, color: "#fff", border: "none" }}
    >
      {label}
    </button>
  );
}

/* ---------- Splash / welcome screen ---------- */
const SPLASH_CSS = `
@keyframes wh-logo-in {
  0%   { opacity: 0; transform: scale(0.82) translateY(12px); }
  60%  { opacity: 1; transform: scale(1.03) translateY(0); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes wh-text-in {
  0%   { opacity: 0; transform: translateY(14px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes wh-ring {
  0%   { transform: scale(0.9); opacity: 0.45; }
  100% { transform: scale(1.35); opacity: 0; }
}
@keyframes wh-bar {
  0%   { width: 0%; }
  100% { width: 100%; }
}
@keyframes wh-fade-out {
  0%   { opacity: 1; }
  100% { opacity: 0; visibility: hidden; }
}
.wh-splash        { animation: wh-fade-out 420ms ease-in 1580ms forwards; }
.wh-splash-logo   { animation: wh-logo-in 700ms cubic-bezier(.2,.8,.2,1) both; }
.wh-splash-ring   { animation: wh-ring 1800ms ease-out infinite; }
.wh-splash-title  { animation: wh-text-in 600ms ease-out 280ms both; }
.wh-splash-sub    { animation: wh-text-in 600ms ease-out 440ms both; }
.wh-splash-bar    { animation: wh-bar 1700ms ease-in-out both; }
`;

function SplashScreen() {
  return (
    <div
      className="wh-splash fixed inset-0 z-[100] flex flex-col items-center justify-center wh-body"
      style={{ background: `linear-gradient(160deg, ${C.accent} 0%, ${C.accent2} 100%)` }}
      dir="rtl"
    >
      <style>{FONTS}</style>
      <style>{SPLASH_CSS}</style>

      <div className="relative flex items-center justify-center mb-7">
        <span
          className="wh-splash-ring absolute rounded-full"
          style={{ width: 168, height: 168, border: "2px solid rgba(255,255,255,0.7)" }}
        />
        <span
          className="wh-splash-ring absolute rounded-full"
          style={{ width: 168, height: 168, border: "2px solid rgba(255,255,255,0.7)", animationDelay: "600ms" }}
        />
        <div
          className="wh-splash-logo rounded-3xl flex items-center justify-center"
          style={{
            width: 132,
            height: 132,
            background: "#fff",
            boxShadow: "0 18px 44px rgba(20,33,61,0.28)",
          }}
        >
          <img
            src="/icon-512-v2.png"
            alt=""
            style={{ width: 104, height: 104, objectFit: "contain" }}
          />
        </div>
      </div>

      <div
        className="wh-splash-title wh-display text-center font-black"
        style={{ color: "#fff", fontSize: 26, letterSpacing: "-0.5px", textShadow: "0 2px 12px rgba(20,33,61,0.25)" }}
      >
        ברוכים הבאים
      </div>
      <div
        className="wh-splash-sub wh-display text-center font-bold mt-1.5"
        style={{ color: "rgba(255,255,255,0.95)", fontSize: 19 }}
      >
        לניהול משק חכם
      </div>

      <div
        className="mt-9 rounded-full overflow-hidden"
        style={{ width: 132, height: 3, background: "rgba(255,255,255,0.28)" }}
      >
        <div className="wh-splash-bar h-full rounded-full" style={{ background: "#fff" }} />
      </div>
    </div>
  );
}

/* Grid editor shaped like the Excel sheet it replaces: one row per dish type,
   one column per day. Tap a cell to pick the dish. */
function WeeklyMenuGrid({ weeklyMenu, setWeekSlot, menuItems, dishTypes, slotKey, slotLabel }) {
  const [cell, setCell] = useState(null); // { dayKey, dayLabel, dishTypeId, dishTypeName }
  const types = dishTypes || [];

  if (types.length === 0) {
    return (
      <ShelfTag accent={C.steel}>
        <p className="text-sm text-center" style={{ color: C.steel }}>
          אין סוגי מנות מוגדרים. הוסף בניהול ← סוגי מנות (למשל: מנה עיקרית, תוספת, ירקנית).
        </p>
      </ShelfTag>
    );
  }

  const nameOf = (dayKey, dtId) => {
    const id = weeklyMenu[dayKey]?.[slotKey]?.[dtId];
    return menuItems.find((m) => m.id === id)?.name || "";
  };

  return (
    <div className="mb-4">
      <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>
        ארוחת {slotLabel}
      </div>

      <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
        <table style={{ borderCollapse: "collapse", minWidth: "100%" }}>
          <thead>
            <tr>
              <th
                style={{
                  background: C.accent,
                  color: "#fff",
                  padding: "8px 6px",
                  border: `1px solid ${C.kraftDark}`,
                  position: "sticky",
                  right: 0,
                  zIndex: 2,
                  minWidth: 84,
                  fontSize: 12,
                }}
              />
              {WEEK_DAYS.map(([, label], idx) => (
                <th
                  key={label}
                  style={{
                    background: C.accent,
                    color: "#fff",
                    padding: "8px 10px",
                    border: `1px solid ${C.kraftDark}`,
                    fontSize: 13,
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                  <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.9 }}>{weekdayDateLabel(idx)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {types.map((dt) => (
              <tr key={dt.id}>
                <th
                  style={{
                    background: "#D6E7F5",
                    color: C.ink,
                    padding: "8px 6px",
                    border: `1px solid ${C.kraftDark}`,
                    textAlign: "right",
                    fontSize: 12,
                    position: "sticky",
                    right: 0,
                    zIndex: 1,
                    minWidth: 84,
                  }}
                >
                  {dt.name}
                </th>
                {WEEK_DAYS.map(([dayKey, dayLabel]) => {
                  const val = nameOf(dayKey, dt.id);
                  return (
                    <td
                      key={dayKey}
                      onClick={() => setCell({ dayKey, dayLabel, dishTypeId: dt.id, dishTypeName: dt.name })}
                      style={{
                        border: `1px solid ${C.kraftDark}`,
                        padding: "8px 10px",
                        textAlign: "center",
                        fontSize: 13,
                        cursor: "pointer",
                        background: val ? "#fff" : "#FAFBFD",
                        color: val ? C.ink : C.kraftDark,
                        minWidth: 96,
                      }}
                    >
                      {val || "+"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cell && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          style={{ background: "rgba(35,31,61,0.5)" }}
          onClick={() => setCell(null)}
        >
          <div
            className="w-full wh-body"
            style={{ background: C.paper, borderRadius: "24px 24px 0 0", maxHeight: "70vh", overflowY: "auto", padding: 16 }}
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
          >
            <div className="flex justify-between items-center mb-3">
              <div>
                <div className="wh-display font-bold" style={{ color: C.ink }}>{cell.dishTypeName}</div>
                <div className="text-xs" style={{ color: C.steel }}>{cell.dayLabel} · ארוחת {slotLabel}</div>
              </div>
              <button onClick={() => setCell(null)} className="px-3 py-1 rounded-full text-sm font-bold" style={{ background: C.ink, color: "#fff" }}>
                סגור
              </button>
            </div>

            <button
              onClick={async () => {
                await setWeekSlot(cell.dayKey, slotKey, cell.dishTypeId, "");
                setCell(null);
              }}
              className="w-full p-3 rounded-2xl text-sm font-bold mb-2 text-right"
              style={{ background: "#fff", color: C.steel, border: `1px solid ${C.kraftDark}` }}
            >
              — רוקן תא —
            </button>

            {menuItems.filter((m) => m.dishType === cell.dishTypeId).length === 0 ? (
              <p className="text-sm text-center py-6" style={{ color: C.steel }}>
                אין מנות מסוג "{cell.dishTypeName}". הוסף בניהול ← תפריט.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {menuItems
                  .filter((m) => m.dishType === cell.dishTypeId)
                  .map((m) => {
                    const selected = weeklyMenu[cell.dayKey]?.[slotKey]?.[cell.dishTypeId] === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={async () => {
                          await setWeekSlot(cell.dayKey, slotKey, cell.dishTypeId, m.id);
                          setCell(null);
                        }}
                        className="p-3 rounded-2xl text-right font-bold"
                        style={{
                          background: selected ? C.sage : "#fff",
                          color: selected ? "#fff" : C.ink,
                          border: `1.5px solid ${selected ? C.sage : C.kraftDark}`,
                        }}
                      >
                        {selected && "✓ "}{m.name}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Unit requests (e.g. the daycare ordering out of our stock) ---------- */

/** ISO date (yyyy-mm-dd) of the Sunday that starts the current week. */
function weekStartIso(d = new Date()) {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}
function weekLabel(iso) {
  const start = new Date(iso);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const f = (d) => d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
  return `${f(start)} – ${f(end)}`;
}
const UNIT_STATUS = {
  open: { label: "פתוחה (ניתן להוסיף)", color: "#5B6B85" },
  submitted: { label: "נשלחה - ממתינה לאישור", color: "#FFB347" },
  fulfilled: { label: "נופקה ✓", color: "#5CB85C" },
  rejected: { label: "נדחתה", color: "#FF5A5F" },
};

function UnitRequestTab({
  products,
  unitRequests,
  persistUnitRequests,
  unitTemplates,
  persistUnitTemplates,
  currentUser,
  showToast,
  notifyManagers,
}) {
  const [view, setView] = useState("current"); // current | template | history
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");

  const thisWeek = weekStartIso();
  const mine = (unitRequests || []).filter((r) => r.unitId === currentUser.id);
  const current = mine.find((r) => r.weekOf === thisWeek && (r.status === "open" || r.status === "submitted"));
  const history = mine.filter((r) => r !== current).sort((a, b) => b.createdAt - a.createdAt);
  const template = (unitTemplates || {})[currentUser.id] || [];

  // Only products the manager exposed to units.
  const catalog = products.filter((p) => p.unitVisible !== false);
  const categories = Array.from(new Set(catalog.map((p) => p.category || "ללא קטגוריה")));
  const filtered = catalog
    .filter((p) => (search ? p.name.includes(search) : true))
    .filter((p) => (catFilter === "all" ? true : (p.category || "ללא קטגוריה") === catFilter));

  const locked = current?.status === "submitted";

  async function upsertCurrent(items) {
    const base = current || {
      id: genId(),
      unitId: currentUser.id,
      unitName: currentUser.name,
      weekOf: thisWeek,
      status: "open",
      createdAt: Date.now(),
      items: [],
      note: "",
    };
    const updated = { ...base, items, updatedAt: Date.now() };
    const others = (unitRequests || []).filter((r) => r.id !== updated.id);
    await persistUnitRequests([...others, updated]);
  }

  async function setQty(product, qty) {
    if (locked) return showToast("הבקשה כבר נשלחה - לא ניתן לשנות");
    const q = Math.max(0, Number(qty) || 0);
    const items = (current?.items || []).filter((i) => i.productId !== product.id);
    if (q > 0) items.push({ productId: product.id, name: product.name, unit: product.unit, qty: q });
    await upsertCurrent(items);
  }

  async function loadFromTemplate() {
    if (locked) return showToast("הבקשה כבר נשלחה");
    if (template.length === 0) return showToast("לא הוגדרה רשימה שבועית קבועה");
    const items = template
      .map((t) => {
        const p = catalog.find((x) => x.id === t.productId);
        return p ? { productId: p.id, name: p.name, unit: p.unit, qty: t.qty } : null;
      })
      .filter(Boolean);
    await upsertCurrent(items);
    showToast(`נטענו ${items.length} מוצרים מהרשימה הקבועה`);
  }

  async function saveAsTemplate() {
    const items = (current?.items || []).map((i) => ({ productId: i.productId, qty: i.qty }));
    if (items.length === 0) return showToast("אין מוצרים לשמור");
    await persistUnitTemplates({ ...(unitTemplates || {}), [currentUser.id]: items });
    showToast("נשמר כרשימה שבועית קבועה ✓");
  }

  async function submit() {
    if (!current || (current.items || []).length === 0) return showToast("הבקשה ריקה");
    const others = (unitRequests || []).filter((r) => r.id !== current.id);
    await persistUnitRequests([...others, { ...current, status: "submitted", submittedAt: Date.now() }]);
    if (notifyManagers) {
      await notifyManagers(`🧺 ${currentUser.name} שלח בקשה שבועית (${current.items.length} מוצרים) - ממתינה לאישורך`, { tab: "admin", section: "unitrequests" });
    }
    showToast("הבקשה נשלחה למחסן ✓");
  }

  async function reopen() {
    const others = (unitRequests || []).filter((r) => r.id !== current.id);
    await persistUnitRequests([...others, { ...current, status: "open" }]);
    showToast("הבקשה נפתחה מחדש לעריכה");
  }

  const qtyOf = (id) => (current?.items || []).find((i) => i.productId === id)?.qty || 0;
  const totalItems = (current?.items || []).length;

  return (
    <div>
      <div className="flex gap-2 mb-4">
        {[["current", "הבקשה השבועית"], ["template", "רשימה קבועה"], ["history", "היסטוריה"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className="flex-1 py-2 rounded-2xl text-sm font-bold"
            style={{ background: view === id ? C.ink : C.kraft, color: view === id ? C.paper : C.ink }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "current" && (
        <>
          <ShelfTag accent={current ? UNIT_STATUS[current.status].color : C.steel} style={{ marginBottom: 16 }}>
            <div className="flex justify-between items-center">
              <div>
                <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>
                  שבוע {weekLabel(thisWeek)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: C.steel }}>
                  {current ? `${totalItems} מוצרים · ${UNIT_STATUS[current.status].label}` : "עדיין לא התחלת בקשה לשבוע הזה"}
                </div>
              </div>
              {template.length > 0 && !locked && (
                <button onClick={loadFromTemplate} className="text-xs font-bold px-3 py-2 rounded-2xl" style={{ background: C.accent, color: "#fff" }}>
                  טען רשימה קבועה
                </button>
              )}
            </div>
            {locked && (
              <button onClick={reopen} className="w-full mt-2 py-2 rounded-2xl text-sm font-bold" style={{ background: C.kraft, color: C.ink }}>
                פתח מחדש לעריכה
              </button>
            )}
          </ShelfTag>

          {totalItems > 0 && (
            <ShelfTag accent={C.sage} style={{ marginBottom: 16 }}>
              <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>מה ביקשת</div>
              <div className="flex flex-col gap-1.5">
                {(current.items || []).map((i) => (
                  <div key={i.productId} className="flex justify-between text-sm">
                    <span style={{ color: C.ink }}>{i.name}</span>
                    <span className="font-bold" style={{ color: C.ink }}>{i.qty} {i.unit}</span>
                  </div>
                ))}
              </div>
              {!locked && (
                <div className="flex gap-2 mt-3">
                  <button onClick={submit} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.sage, color: "#fff" }}>
                    שלח למחסן
                  </button>
                  <button onClick={saveAsTemplate} className="px-3 py-2 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink }}>
                    שמור כקבועה
                  </button>
                </div>
              )}
            </ShelfTag>
          )}

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש מוצר..."
            className="w-full p-3 rounded-2xl border mb-3"
            style={{ borderColor: C.kraftDark, background: "#fff" }}
          />

          <div className="flex gap-2 overflow-x-auto pb-2 mb-3">
            <button
              onClick={() => setCatFilter("all")}
              className="px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap"
              style={{ background: catFilter === "all" ? C.ink : "#fff", color: catFilter === "all" ? "#fff" : C.ink, border: `1px solid ${C.kraftDark}` }}
            >
              הכל
            </button>
            {categories.map((c) => {
              const col = categoryColor(c);
              const active = catFilter === c;
              return (
                <button
                  key={c}
                  onClick={() => setCatFilter(c)}
                  className="px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap"
                  style={{ background: active ? col : "#fff", color: active ? "#fff" : col, border: `1.5px solid ${col}` }}
                >
                  {c}
                </button>
              );
            })}
          </div>

          {catalog.length === 0 && (
            <ShelfTag accent={C.steel}>
              <p className="text-sm text-center" style={{ color: C.steel }}>
                המנהל עדיין לא פתח מוצרים להזמנה. פנה אליו.
              </p>
            </ShelfTag>
          )}

          <div className="flex flex-col gap-2">
            {filtered.map((p) => {
              const q = qtyOf(p.id);
              return (
                <ShelfTag key={p.id} accent={q > 0 ? C.sage : C.kraftDark}>
                  <div className="flex justify-between items-center">
                    <div className="flex gap-2 items-center">
                      {p.imageData && (
                        <img src={p.imageData} alt="" className="rounded-xl" style={{ width: 44, height: 44, objectFit: "cover" }} />
                      )}
                      <div>
                        <div className="font-bold text-sm" style={{ color: C.ink }}>{p.name}</div>
                        <div className="text-xs" style={{ color: C.steel }}>{p.category || "ללא קטגוריה"}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setQty(p, q - 1)}
                        disabled={locked || q === 0}
                        className="w-8 h-8 rounded-xl font-bold"
                        style={{ background: C.paper, border: `1px solid ${C.kraftDark}`, opacity: locked || q === 0 ? 0.4 : 1 }}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        value={q === 0 ? "" : q}
                        onChange={(e) => setQty(p, e.target.value)}
                        disabled={locked}
                        placeholder="0"
                        className="w-14 text-center p-1.5 rounded-xl border"
                        style={{ borderColor: C.kraftDark }}
                      />
                      <button
                        onClick={() => setQty(p, q + 1)}
                        disabled={locked}
                        className="w-8 h-8 rounded-xl font-bold"
                        style={{ background: C.paper, border: `1px solid ${C.kraftDark}`, opacity: locked ? 0.4 : 1 }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </ShelfTag>
              );
            })}
          </div>
        </>
      )}

      {view === "template" && (
        <ShelfTag accent={C.accent}>
          <div className="wh-display font-bold text-sm mb-1" style={{ color: C.ink }}>הרשימה השבועית הקבועה</div>
          <p className="text-xs mb-3" style={{ color: C.steel }}>
            הדברים שאתם מזמינים כל שבוע. בנו בקשה בלשונית "הבקשה השבועית", לחצו "שמור כקבועה", ומאז אפשר לטעון אותה בלחיצה אחת בכל שבוע.
          </p>
          {template.length === 0 ? (
            <p className="text-sm text-center py-4" style={{ color: C.steel }}>עדיין לא הוגדרה רשימה קבועה</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {template.map((t) => {
                const p = products.find((x) => x.id === t.productId);
                if (!p) return null;
                return (
                  <div key={t.productId} className="flex justify-between text-sm">
                    <span style={{ color: C.ink }}>{p.name}</span>
                    <span className="font-bold" style={{ color: C.ink }}>{t.qty} {p.unit}</span>
                  </div>
                );
              })}
            </div>
          )}
        </ShelfTag>
      )}

      {view === "history" && (
        <div className="flex flex-col gap-2">
          {history.length === 0 && (
            <p className="text-sm text-center py-8" style={{ color: C.steel }}>אין בקשות קודמות</p>
          )}
          {history.map((r) => {
            const st = UNIT_STATUS[r.status] || UNIT_STATUS.open;
            return (
              <ShelfTag key={r.id} accent={st.color}>
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-bold text-sm" style={{ color: C.ink }}>שבוע {weekLabel(r.weekOf)}</div>
                    <div className="text-xs" style={{ color: C.steel }}>{(r.items || []).length} מוצרים</div>
                  </div>
                  <span className="text-xs font-bold px-2 py-1 rounded-full" style={{ background: st.color, color: "#fff" }}>
                    {st.label}
                  </span>
                </div>
                {r.managerNote && (
                  <div className="text-xs mt-2 p-2 rounded-xl" style={{ background: C.paper, color: C.steel }}>
                    הערת המחסן: {r.managerNote}
                  </div>
                )}
              </ShelfTag>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- Main App ---------- */
export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(() =>
    typeof window !== "undefined" && window.location.hash.includes("type=recovery")
  );
  const [authProfile, setAuthProfile] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [settings, setSettings] = useState({ supplierPhone: "" });
  const [notifications, setNotifications] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [weeklyMenu, setWeeklyMenu] = useState({});
  const [reminders, setReminders] = useState([]);
  const [stockLog, setStockLog] = useState([]);
  const [orderHistory, setOrderHistory] = useState([]);
  const [locations, setLocations] = useState([]);
  const [dishTypes, setDishTypes] = useState([]);
  const [taskCategories, setTaskCategories] = useState([]);
  const [orderRequests, setOrderRequests] = useState([]);
  const [unitRequests, setUnitRequests] = useState([]);
  const [unitTemplates, setUnitTemplates] = useState({});
  const [currentUser, setCurrentUser] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanResult, setScanResult] = useState(null); // { code, product|null }
  const [toast, setToast] = useState("");
  const [showNotifications, setShowNotifications] = useState(false);
  const [adminSection, setAdminSection] = useState(null); // set when a notification points at an admin screen
  const [focusTaskId, setFocusTaskId] = useState(null);   // task to auto-open after tapping a notification
  const [showMenu, setShowMenu] = useState(false);
  const [locked, setLocked] = useState(() => isBiometricEnabled());
  const [biometricPrompt, setBiometricPrompt] = useState(false);
  const [notifBanner, setNotifBanner] = useState(false);
  const seenNotifIdsRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setSplashDone(true), 2100);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const session = await window.auth.getSession();
        if (session) {
          try {
            const profile = await window.auth.getMyProfile();
            if (profile) {
              setAuthProfile(profile);
              try {
                localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
              } catch (e) {}
            }
          } catch (e) {
            // Offline (or the server is unreachable): the Supabase session itself is
            // stored locally and still valid, so fall back to the last known profile
            // instead of bouncing a logged-in user back to the login screen.
            console.error("getMyProfile failed, falling back to cached profile", e);
            const cached = cachedProfile();
            if (cached) setAuthProfile(cached);
          }
        }
      } catch (e) {
        console.error(e);
        const cached = cachedProfile();
        if (cached) setAuthProfile(cached);
      }
      setAuthChecked(true);
    })();
  }, []);

  useEffect(() => {
    if (authProfile) {
      setCurrentUser({
        id: authProfile.id,
        name: authProfile.display_name || authProfile.email || "משתמש",
        email: authProfile.email,
        phone: authProfile.phone || "",
        role: authProfile.role,
        orgId: authProfile.org_id,
        permissions: { ...DEFAULT_PERMISSIONS, ...(authProfile.permissions || {}) },
      });
    } else {
      setCurrentUser(null);
    }
  }, [authProfile]);

  useEffect(() => {
    if (!currentUser) return;
    if (isManager(currentUser)) return;
    const perms = currentUser.permissions || DEFAULT_PERMISSIONS;

    // A unit user (e.g. the daycare) whose only permission is requesting from stock
    // should land straight on that screen instead of an empty inventory tab.
    if (perms.unitRequest === true && perms.inventory === false && perms.order === false && perms.tasks === false) {
      if (tab !== "unitrequest") setTab("unitrequest");
      return;
    }

    if (tab === "tasks" && perms.tasks === false) {
      if (perms.inventory !== false) setTab("inventory");
      else if (perms.order !== false) setTab("order");
    } else if (tab === "inventory" && perms.inventory === false) {
      if (perms.order !== false) setTab("order");
      else if (perms.tasks !== false) setTab("tasks");
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    setLoaded(false);
    seenNotifIdsRef.current = null;
    (async () => {
      const [orgProfiles, p, t, s, n, m, w, r, sl, loc, dt, tc, orq, ur, ut, oh] = await Promise.all([
        (async () => {
          try {
            const list = await window.auth.getOrgProfiles();
            if (list) await cacheSet("__org_profiles__", list);
            return list;
          } catch (e) {
            console.error("getOrgProfiles failed, using cache", e);
            return (await cacheGet("__org_profiles__")) || [];
          }
        })(),
        loadKey(KEYS.products, []),
        loadKey(KEYS.tasks, []),
        loadKey(KEYS.settings, { supplierPhone: "" }),
        loadKey(KEYS.notifications, []),
        loadKey(KEYS.menuItems, []),
        loadKey(KEYS.weeklyMenu, {}),
        loadKey(KEYS.reminders, []),
        loadKey(KEYS.stockLog, []),
        loadKey(KEYS.orderHistory, []),
        loadKey(KEYS.locations, null),
        loadKey(KEYS.dishTypes, null),
        loadKey(KEYS.taskCategories, null),
        loadKey(KEYS.orderRequests, []),
        loadKey(KEYS.unitRequests, []),
        loadKey(KEYS.unitTemplates, {}),
      ]);
      const finalLocations = loc || [];
      let finalDishTypes = dt;
      if (finalDishTypes === null) {
        finalDishTypes = [
          { id: genId(), name: "מנה עיקרית" },
          { id: genId(), name: "תוספת" },
          { id: genId(), name: "ירקנית" },
        ];
        await saveKey(KEYS.dishTypes, finalDishTypes);
      }
      let finalTaskCategories = tc;
      if (finalTaskCategories === null) {
        finalTaskCategories = [
          { id: genId(), name: "חשמל", icon: "⚡" },
          { id: genId(), name: "אינסטלציה", icon: "🔧" },
          { id: genId(), name: "נגרות", icon: "🪚" },
          { id: genId(), name: "מיזוג", icon: "❄️" },
          { id: genId(), name: "ניקיון", icon: "🧹" },
          { id: genId(), name: "מטבח", icon: "🍳" },
          { id: genId(), name: "כללי", icon: "📋" },
        ];
        await saveKey(KEYS.taskCategories, finalTaskCategories);
      }

      const finalUsers = (orgProfiles || []).map((prof) => ({
        id: prof.id,
        name: prof.display_name || "משתמש",
        phone: prof.phone || "",
        loginEmail: prof.email || "",
        contactEmail: prof.contact_email || "",
        role: prof.role,
        permissions: { ...DEFAULT_PERMISSIONS, ...(prof.permissions || {}) },
      }));

      // Check recurring reminders: if a reminder's scheduled weekday has passed
      // since it last fired, spawn a task + notification for it now.
      let finalTasks = t || [];
      let finalNotifications = n || [];
      let finalReminders = r || [];
      let remindersChanged = false;
      const finalProducts = p || [];

      function mostRecentDateForWeekday(weekday) {
        const now = new Date();
        const diff = (now.getDay() - weekday + 7) % 7;
        const d = new Date(now);
        d.setDate(now.getDate() - diff);
        return d.toISOString().slice(0, 10);
      }

      finalReminders = finalReminders.map((rem) => {
        if (!rem.active) return rem;
        const triggerDate = mostRecentDateForWeekday(rem.dayOfWeek);
        if (rem.lastTriggeredDate === triggerDate) return rem;
        const product = finalProducts.find((pp) => pp.id === rem.productId);
        const title = product ? `תזכורת: בדוק ${product.name}` : `תזכורת: ${rem.title}`;
        finalTasks = [
          ...finalTasks,
          {
            id: genId(),
            title,
            description: rem.title,
            assignedToId: rem.assignedToId,
            priority: "normal",
            location: "",
            status: "open",
            createdAt: Date.now(),
            createdBy: "תזכורת אוטומטית",
          },
        ];
        finalNotifications = [
          ...finalNotifications,
          { id: genId(), userId: rem.assignedToId, message: title, read: false, createdAt: Date.now() },
        ];
        remindersChanged = true;
        return { ...rem, lastTriggeredDate: triggerDate };
      });

      if (remindersChanged) {
        await saveKey(KEYS.tasks, finalTasks);
        await saveKey(KEYS.notifications, finalNotifications);
        await saveKey(KEYS.reminders, finalReminders);
      }

      setUsers(finalUsers);
      setProducts(finalProducts);
      setTasks(finalTasks);
      setSettings(s || { supplierPhone: "" });
      setNotifications(finalNotifications);
      setMenuItems(m || []);
      setWeeklyMenu(w || {});
      setReminders(finalReminders);
      setStockLog(sl || []);
      setOrderHistory(oh || []);
      setLocations(finalLocations || []);
      setDishTypes(finalDishTypes || []);
      setTaskCategories(finalTaskCategories || []);
      if (typeof window !== "undefined") window.__taskCats = finalTaskCategories || [];
      setOrderRequests(orq || []);
      setUnitRequests(ur || []);
      setUnitTemplates(ut || {});
      setLoaded(true);
    })();
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser) return;
    let unsubscribe = () => {};
    const reloadMap = {
      [KEYS.products]: async () => setProducts((await loadKey(KEYS.products, [])) || []),
      [KEYS.tasks]: async () => setTasks((await loadKey(KEYS.tasks, [])) || []),
      [KEYS.settings]: async () => setSettings((await loadKey(KEYS.settings, { supplierPhone: "" })) || { supplierPhone: "" }),
      [KEYS.notifications]: async () => setNotifications((await loadKey(KEYS.notifications, [])) || []),
      [KEYS.menuItems]: async () => setMenuItems((await loadKey(KEYS.menuItems, [])) || []),
      [KEYS.weeklyMenu]: async () => setWeeklyMenu((await loadKey(KEYS.weeklyMenu, {})) || {}),
      [KEYS.reminders]: async () => setReminders((await loadKey(KEYS.reminders, [])) || []),
      [KEYS.stockLog]: async () => setStockLog((await loadKey(KEYS.stockLog, [])) || []),
      [KEYS.orderHistory]: async () => setOrderHistory((await loadKey(KEYS.orderHistory, [])) || []),
      [KEYS.locations]: async () => setLocations((await loadKey(KEYS.locations, [])) || []),
      [KEYS.dishTypes]: async () => setDishTypes((await loadKey(KEYS.dishTypes, [])) || []),
      [KEYS.taskCategories]: async () => setTaskCategories((await loadKey(KEYS.taskCategories, [])) || []),
      [KEYS.orderRequests]: async () => setOrderRequests((await loadKey(KEYS.orderRequests, [])) || []),
      [KEYS.unitRequests]: async () => setUnitRequests((await loadKey(KEYS.unitRequests, [])) || []),
      [KEYS.unitTemplates]: async () => setUnitTemplates((await loadKey(KEYS.unitTemplates, {})) || {}),
    };
    window.auth.subscribeToOrgChanges((payload) => {
      const changedKey = payload.new?.key || payload.old?.key;
      const reloader = reloadMap[changedKey];
      if (reloader) reloader();
    })
      .then((fn) => {
        unsubscribe = fn;
      })
      .catch((e) => {
        // No network: realtime just isn't available. The app keeps working from
        // the local cache and will re-subscribe on the next load.
        console.error("realtime subscribe failed", e);
      });
    // also refresh the team member list occasionally isn't covered by kv_store changes
    // (profiles table changes aren't part of this subscription), so no action needed there.
    return () => unsubscribe();
  }, [currentUser?.id]);

  useEffect(() => {
    if (!loaded || !currentUser || locked) return;
    if (isBiometricEnabled() || hasPromptedBiometric()) return;
    isBiometricSupported().then((supported) => {
      if (supported) setBiometricPrompt(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, currentUser?.id]);

  /* Fire an OS notification for any notification that newly appears for me.
     The first pass only seeds the baseline, so existing/old items stay quiet. */
  useEffect(() => {
    if (!loaded || !currentUser) return;
    const mine = notifications.filter((n) => n.userId === currentUser.id);

    if (seenNotifIdsRef.current === null) {
      seenNotifIdsRef.current = new Set(mine.map((n) => n.id));
      return;
    }

    mine.forEach((n) => {
      if (seenNotifIdsRef.current.has(n.id)) return;
      seenNotifIdsRef.current.add(n.id);
      if (n.read) return;
      showOsNotification("משימה חדשה 📋", n.message, n.id);
    });
  }, [notifications, loaded, currentUser?.id]);

  /* Offer to turn on notifications once, after the biometric prompt is out of the way. */
  useEffect(() => {
    if (!loaded || !currentUser || locked || biometricPrompt) return;
    if (!notificationsSupported()) return;
    if (notificationPermission() !== "default") return;
    if (hasPromptedNotifications()) return;
    setNotifBanner(true);
  }, [loaded, currentUser?.id, locked, biometricPrompt]);

  /* Push endpoints can silently expire (browser update, long inactivity). Re-registering
     on every load is cheap - it upserts on the same endpoint - and keeps delivery alive. */
  useEffect(() => {
    if (!loaded || !currentUser || locked) return;
    if (!notificationsSupported() || notificationPermission() !== "granted") return;
    (async () => {
      try {
        if (window.auth?.registerPush) await window.auth.registerPush();
      } catch (e) {
        console.error("push re-registration failed", e);
      }
    })();
  }, [loaded, currentUser?.id, locked]);

  /* Follow-up reminders. Whichever device is open when one comes due fires it, and
     stamps followUpFiredAt so it never fires twice. Checked on load and every 5 min. */
  useEffect(() => {
    if (!loaded || !currentUser) return;

    async function checkFollowUps() {
      const now = Date.now();
      const due = tasks.filter(
        (t) => t.followUpAt && !t.followUpFiredAt && t.followUpAt <= now && t.status !== "done"
      );
      if (due.length === 0) return;

      const next = tasks.map((t) =>
        due.some((d) => d.id === t.id) ? { ...t, followUpFiredAt: now } : t
      );
      await persistTasks(next);

      for (const t of due) {
        const msg = `⏰ בדיקת המשך: ${t.title}`;
        const link = { tab: "tasks", taskId: t.id };
        // Nudge the assignee, and the manager who set it if that's someone else.
        const recipients = new Set([t.assignedToId, t.createdById].filter(Boolean));
        for (const uid of recipients) {
          await notifyUser(uid, msg, link);
        }
      }
    }

    checkFollowUps();
    const interval = setInterval(checkFollowUps, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, currentUser?.id, tasks]);

  /* Tapping a notification takes you to whatever it's about, marks it read,
     and closes the panel. Older notifications have no link - they just get marked read. */
  async function openNotification(n) {
    const next = notifications.map((x) => (x.id === n.id ? { ...x, read: true } : x));
    await persistNotifications(next);
    setShowNotifications(false);

    if (!n.link) return;
    const { tab: target, section, taskId } = n.link;

    if (section) setAdminSection(section);
    if (taskId) setFocusTaskId(taskId);
    if (target) setTab(target);
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }

  async function persistProducts(next) {
    setProducts(next);
    await saveKey(KEYS.products, next);
  }
  async function updateUserProfile(id, fields) {
    await window.auth.updateProfile(id, fields);
    setUsers((cur) =>
      cur.map((u) =>
        u.id === id
          ? {
              ...u,
              ...fields,
              name: fields.display_name ?? u.name,
              contactEmail: fields.contact_email ?? u.contactEmail,
            }
          : u
      )
    );
  }
  async function deleteUserProfile(id) {
    await window.auth.deleteProfile(id);
    setUsers((cur) => cur.filter((u) => u.id !== id));
  }
  async function persistTasks(next) {
    setTasks(next);
    await saveKey(KEYS.tasks, next);
  }
  async function persistSettings(next) {
    setSettings(next);
    await saveKey(KEYS.settings, next);
  }
  async function persistNotifications(next) {
    setNotifications(next);
    await saveKey(KEYS.notifications, next);
  }
  async function persistMenuItems(next) {
    setMenuItems(next);
    await saveKey(KEYS.menuItems, next);
  }
  async function persistWeeklyMenu(next) {
    setWeeklyMenu(next);
    await saveKey(KEYS.weeklyMenu, next);
  }
  async function persistReminders(next) {
    setReminders(next);
    await saveKey(KEYS.reminders, next);
  }
  async function persistStockLog(next) {
    setStockLog(next);
    await saveKey(KEYS.stockLog, next);
  }
  async function persistOrderHistory(next) {
    setOrderHistory(next);
    await saveKey(KEYS.orderHistory, next);
  }
  async function recordOrder(entry) {
    // Keep the last 300 orders - plenty of history without bloating storage.
    const next = [{ id: genId(), createdAt: Date.now(), ...entry }, ...orderHistory].slice(0, 300);
    await persistOrderHistory(next);
  }
  async function logStockChange(productId, delta, userName) {
    if (!delta) return;
    const next = [...stockLog, { id: genId(), productId, delta, userName, timestamp: Date.now() }];
    await persistStockLog(next);
  }
  async function persistLocations(next) {
    setLocations(next);
    await saveKey(KEYS.locations, next);
  }
  async function persistDishTypes(next) {
    setDishTypes(next);
    await saveKey(KEYS.dishTypes, next);
  }
  async function persistTaskCategories(next) {
    setTaskCategories(next);
    await saveKey(KEYS.taskCategories, next);
  }

  async function persistUnitRequests(next) {
    setUnitRequests(next);
    await saveKey(KEYS.unitRequests, next);
  }
  async function persistUnitTemplates(next) {
    setUnitTemplates(next);
    await saveKey(KEYS.unitTemplates, next);
  }
  async function persistOrderRequests(next) {
    setOrderRequests(next);
    await saveKey(KEYS.orderRequests, next);
  }
  /** Notify every manager in the org (used when a supervisor submits an order request). */
  /* Two layers on purpose:
     1. The in-app notification (kv_store + realtime) - the source of truth.
     2. A real Web Push - the only thing that reaches a phone whose app is CLOSED.
     Push is best-effort: if the Edge Function is down or we're offline, the in-app
     notification still lands, and the OS notification fires next time the app opens. */
  async function pushTo(userIds, title, body) {
    try {
      if (!window.auth?.sendPush) return;
      const ids = userIds.filter(Boolean);
      if (ids.length === 0) return;
      await window.auth.sendPush({ userIds: ids, title, body, url: "/" });
    } catch (e) {
      console.error("push send failed (in-app notification still delivered)", e);
    }
  }

  async function notifyManagers(message, link) {
    const managers = users.filter((u) => u.role === "manager");
    if (managers.length === 0) return;
    const next = [
      ...notifications,
      ...managers.map((u) => ({ id: genId(), userId: u.id, message, link, read: false, createdAt: Date.now() })),
    ];
    await persistNotifications(next);
    pushTo(managers.map((u) => u.id), "ניהול משק חכם", message);
  }
  /* `link` tells the notification bell where to jump when tapped, e.g.
     { tab: "tasks", taskId } or { tab: "admin", section: "unitrequests" }. */
  async function notifyUser(userId, message, link) {
    const next = [
      ...notifications,
      { id: genId(), userId, message, link, read: false, createdAt: Date.now() },
    ];
    await persistNotifications(next);
    pushTo([userId], "ניהול משק חכם", message);
  }

  const lowStock = products.filter((p) => Number(p.quantity) <= Number(p.threshold));
  const myOpenTasks = currentUser
    ? tasks.filter((t) => t.assignedToId === currentUser.id && t.status !== "done")
    : [];
  const myNotifications = currentUser
    ? notifications.filter((n) => n.userId === currentUser.id).sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const unreadCount = myNotifications.filter((n) => !n.read).length;
  const pendingRequestCount = (orderRequests || []).filter((r) => r.status === "pending").length;

  if (!splashDone) {
    return <SplashScreen />;
  }

  if (passwordRecovery) {
    return <SetNewPasswordScreen onDone={() => setPasswordRecovery(false)} />;
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: C.paper }}>
        <p className="wh-body" style={{ color: C.steel }}>טוען...</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <AuthGate
        onAuthed={async () => {
          const profile = await window.auth.getMyProfile();
          if (profile) setAuthProfile(profile);
        }}
      />
    );
  }

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: C.paper }}>
        <p className="wh-body" style={{ color: C.steel }}>טוען...</p>
      </div>
    );
  }

  if (locked) {
    return (
      <LockScreen
        onUnlock={() => setLocked(false)}
        onUseLogout={async () => {
          disableBiometric();
          await window.auth.signOut();
          setAuthProfile(null);
          setLocked(false);
        }}
      />
    );
  }

  function handleScanDetected(code) {
    const product = products.find((p) => p.barcode === code);
    setScanResult({ code, product: product || null });
    setScannerOpen(false);
  }

  return (
    <div className="min-h-screen flex flex-col wh-body" style={{ background: C.paper, position: "relative" }} dir="rtl">
      <style>{FONTS}</style>
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: "url(/icon-512-v2.png)",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
          backgroundSize: "60vw",
          opacity: 0.05,
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      <div style={{ position: "relative", zIndex: 1 }} className="flex flex-col min-h-screen">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3" style={{ background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`, borderRadius: "0 0 24px 24px" }}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowMenu(true)}
            className="text-xl px-2 py-1 rounded-full"
            style={{ background: "rgba(255,255,255,0.25)", color: "#fff" }}
            aria-label="תפריט"
          >
            ☰
          </button>
          <div>
            <div className="wh-display font-black text-lg" style={{ color: C.paper }}>ניהול משימות ומלאי מוסדי</div>
            <div className="text-xs" style={{ color: C.kraft }}>
              {currentUser.name} · {roleLabel(currentUser.role)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNotifications((v) => !v)}
            className="relative text-lg px-2 py-1 rounded-full"
            style={{ background: "rgba(255,255,255,0.25)" }}
          >
            🔔
            {unreadCount > 0 && (
              <span
                className="absolute -top-1 -left-1 rounded-full text-[10px] px-1.5 py-0.5 font-bold"
                style={{ background: C.stamp, color: "#fff", minWidth: 16 }}
              >
                {unreadCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <SyncBar showToast={showToast} />

      {showNotifications && (
        <div
          className="fixed top-16 left-4 right-4 z-40 rounded-2xl p-3 wh-body"
          style={{ background: "#fff", boxShadow: "0 8px 24px rgba(35,31,61,0.2)", maxHeight: "60vh", overflowY: "auto" }}
        >
          <div className="flex justify-between items-center mb-2">
            <span className="wh-display font-bold" style={{ color: C.ink }}>התראות</span>
            <button
              onClick={async () => {
                const next = notifications.map((n) => (n.userId === currentUser.id ? { ...n, read: true } : n));
                await persistNotifications(next);
              }}
              className="text-xs font-bold"
              style={{ color: C.accent }}
            >
              סמן הכל כנקרא
            </button>
          </div>
          {myNotifications.length === 0 ? (
            <p className="text-sm text-center py-4" style={{ color: C.steel }}>אין התראות</p>
          ) : (
            <div className="flex flex-col gap-2">
              {myNotifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openNotification(n)}
                  className="p-2 rounded-xl text-sm text-right flex items-center gap-2"
                  style={{
                    background: n.read ? C.paper : "#EFEAFF",
                    color: C.ink,
                    cursor: n.link ? "pointer" : "default",
                    border: `1px solid ${n.read ? C.kraftDark : "#D8CEFF"}`,
                  }}
                >
                  <span className="flex-1">{n.message}</span>
                  {n.link && <span style={{ color: C.accent, fontWeight: 700 }}>‹</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className="fixed top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-2xl wh-body text-sm font-medium"
          style={{ background: C.ink, color: C.paper }}
        >
          {toast}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {notifBanner && (
          <ShelfTag accent={C.mustard} style={{ marginBottom: 16 }}>
            <div className="flex items-start gap-3">
              <div className="text-2xl">🔔</div>
              <div className="flex-1">
                <div className="wh-display font-bold text-sm mb-1" style={{ color: C.ink }}>
                  להפעיל התראות?
                </div>
                <p className="text-xs mb-3" style={{ color: C.steel }}>
                  תקבל התראה בטלפון ברגע שמוקצית לך משימה חדשה - גם כשהאפליקציה סגורה לגמרי.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      const result = await enablePushOnThisDevice();
                      setNotifBanner(false);
                      if (result === "granted") {
                        showToast("התראות הופעלו");
                        showOsNotification("ההתראות פעילות ✓", "תקבל התראה גם כשהאפליקציה סגורה.", "test");
                      } else {
                        showToast("ההתראות לא הופעלו");
                      }
                    }}
                    className="px-4 py-2 rounded-2xl font-bold text-sm"
                    style={{ background: C.ink, color: C.paper }}
                  >
                    הפעל
                  </button>
                  <button
                    onClick={() => { markPromptedNotifications(); setNotifBanner(false); }}
                    className="px-4 py-2 rounded-2xl text-sm"
                    style={{ color: C.steel }}
                  >
                    לא עכשיו
                  </button>
                </div>
              </div>
            </div>
          </ShelfTag>
        )}
        {tab === "dashboard" && (
          <Dashboard
            tasks={tasks}
            products={products}
            orderHistory={orderHistory}
            users={users}
            currentUser={currentUser}
            unitRequests={unitRequests}
            onGoTo={(t) => setTab(t)}
          />
        )}
        {tab === "inventory" && (
          <InventoryTab
            products={products}
            persistProducts={persistProducts}
            openScanner={() => setScannerOpen(true)}
            scanResult={scanResult}
            clearScanResult={() => setScanResult(null)}
            currentUser={currentUser}
            showToast={showToast}
            isManager={isManager(currentUser)}
            logStockChange={logStockChange}
            initialSection={adminSection}
            onSectionConsumed={() => setAdminSection(null)}
          />
        )}
        {tab === "order" && (
          <OrderTab
            lowStock={lowStock}
            products={products}
            settings={settings}
            persistSettings={persistSettings}
            isManager={isManager(currentUser)}
            menuItems={menuItems}
            weeklyMenu={weeklyMenu}
            persistWeeklyMenu={persistWeeklyMenu}
            showToast={showToast}
            dishTypes={dishTypes}
            currentUser={currentUser}
            orderRequests={orderRequests}
            persistOrderRequests={persistOrderRequests}
            notifyManagers={notifyManagers}
            recordOrder={recordOrder}
          />
        )}
        {tab === "tasks" && (
          <TasksTab
            tasks={tasks}
            persistTasks={persistTasks}
            users={users}
            currentUser={currentUser}
            showToast={showToast}
            notifyUser={notifyUser}
            locations={locations}
            taskCategories={taskCategories}
            focusTaskId={focusTaskId}
            onFocusConsumed={() => setFocusTaskId(null)}
          />
        )}
        {tab === "unitrequest" && canRequestFromStock(currentUser) && (
          <UnitRequestTab
            products={products}
            unitRequests={unitRequests}
            persistUnitRequests={persistUnitRequests}
            unitTemplates={unitTemplates}
            persistUnitTemplates={persistUnitTemplates}
            currentUser={currentUser}
            showToast={showToast}
            notifyManagers={notifyManagers}
          />
        )}
        {tab === "admin" && hasAnyAdminSection(currentUser) && (
          <AdminTab
            users={users}
            updateUserProfile={updateUserProfile}
            deleteUserProfile={deleteUserProfile}
            currentUser={currentUser}
            products={products}
            persistProducts={persistProducts}
            settings={settings}
            persistSettings={persistSettings}
            showToast={showToast}
            menuItems={menuItems}
            persistMenuItems={persistMenuItems}
            weeklyMenu={weeklyMenu}
            persistWeeklyMenu={persistWeeklyMenu}
            reminders={reminders}
            persistReminders={persistReminders}
            stockLog={stockLog}
            locations={locations}
            persistLocations={persistLocations}
            dishTypes={dishTypes}
            persistDishTypes={persistDishTypes}
            taskCategories={taskCategories}
            persistTaskCategories={persistTaskCategories}
            orderRequests={orderRequests}
            persistOrderRequests={persistOrderRequests}
            notifyUser={notifyUser}
            unitRequests={unitRequests}
            persistUnitRequests={persistUnitRequests}
            logStockChange={logStockChange}
            tasks={tasks}
            orderHistory={orderHistory}
          />
        )}
      </div>

      {/* Side drawer menu */}
      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            style={{ background: "rgba(35,31,61,0.4)" }}
            onClick={() => setShowMenu(false)}
          />
          <div
            className="fixed top-0 right-0 bottom-0 z-50 flex flex-col wh-body"
            style={{ width: "78%", maxWidth: 300, background: C.paper, boxShadow: "-8px 0 24px rgba(35,31,61,0.25)", borderRadius: "24px 0 0 24px" }}
          >
            <div className="p-4" style={{ background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`, borderRadius: "24px 0 0 0" }}>
              <div className="wh-display font-black text-lg" style={{ color: "#fff" }}>ניהול משימות ומלאי מוסדי</div>
              <div className="text-xs" style={{ color: "#fff" }}>{currentUser.name} · {roleLabel(currentUser.role)}</div>
            </div>
            <div className="flex flex-col p-3 gap-2 flex-1">
              <DrawerItem label="🏠 בית" active={tab === "dashboard"} onClick={() => { setTab("dashboard"); setShowMenu(false); }} />
              {(isManager(currentUser) || currentUser.permissions?.inventory !== false) && (
                <DrawerItem label="מלאי" active={tab === "inventory"} onClick={() => { setTab("inventory"); setShowMenu(false); }} />
              )}
              {(isManager(currentUser) || currentUser.permissions?.order !== false) && (
                <DrawerItem
                  label="הזמנה"
                  active={tab === "order"}
                  onClick={() => { setTab("order"); setShowMenu(false); }}
                  badge={lowStock.length > 0 ? lowStock.length : null}
                  badgeColor={C.stamp}
                />
              )}
              {(isManager(currentUser) || currentUser.permissions?.tasks !== false) && (
                <DrawerItem
                  label="משימות"
                  active={tab === "tasks"}
                  onClick={() => { setTab("tasks"); setShowMenu(false); }}
                  badge={myOpenTasks.length > 0 ? myOpenTasks.length : null}
                  badgeColor={C.mustard}
                />
              )}
              {canRequestFromStock(currentUser) && (
                <DrawerItem
                  label="בקשה מהמחסן"
                  active={tab === "unitrequest"}
                  onClick={() => { setTab("unitrequest"); setShowMenu(false); }}
                />
              )}
              {hasAnyAdminSection(currentUser) && (
                <DrawerItem
                  label="ניהול"
                  active={tab === "admin"}
                  onClick={() => { setTab("admin"); setShowMenu(false); }}
                  badge={isManager(currentUser) && pendingRequestCount > 0 ? pendingRequestCount : null}
                  badgeColor={C.stamp}
                />
              )}
            </div>
            {isManager(currentUser) && (
              <div className="mx-3 mb-2 p-3 rounded-2xl" style={{ background: C.paper }}>
                <div className="text-xs font-bold mb-1" style={{ color: C.steel }}>לחיבור עובד חדש למסד הזה:</div>
                <div className="text-xs" style={{ color: C.steel }}>
                  שתף איתו את מזהה הארגון (זמין למנהל במסך ניהול ← עובדים) - הוא יזין אותו ב"הצטרף לארגון קיים" בהרשמה הראשונה שלו.
                </div>
              </div>
            )}
            <NotificationsToggle showToast={showToast} />
            <BiometricToggle currentUser={currentUser} showToast={showToast} />
            <button
              onClick={async () => { await window.auth.signOut(); setAuthProfile(null); setShowMenu(false); }}
              className="m-3 py-2 rounded-2xl font-bold text-sm"
              style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
            >
              יציאה
            </button>
            <p className="text-center text-xs" style={{ color: C.steel }}>
              © כל הזכויות שמורות לנפתלי קמפה · ת.ז. 313****31
            </p>
            <p className="text-center text-xs pb-3">
              <a
                href={`https://wa.me/972585120140?text=${encodeURIComponent("שלום, רציתי לפתח/להוסיף:")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: C.accent }}
              >
                המלצות/פניות לפיתוח: 0585120140
              </a>
            </p>
          </div>
        </>
      )}

      {scannerOpen && (
        <BarcodeScanner onDetected={handleScanDetected} onClose={() => setScannerOpen(false)} />
      )}

      {biometricPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(35,31,61,0.5)" }}>
          <div className="w-full max-w-xs p-5 rounded-2xl wh-body text-center" style={{ background: C.paper }}>
            <div className="text-4xl mb-3">👆</div>
            <div className="wh-display font-bold mb-2" style={{ color: C.ink }}>כניסה מהירה?</div>
            <p className="text-sm mb-4" style={{ color: C.steel }}>
              רוצה להפעיל כניסה עם טביעת אצבע / זיהוי פנים במכשיר הזה, כדי לא להקליד סיסמה בכל פעם?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={async () => {
                  try {
                    await registerBiometric(currentUser.name);
                    showToast("נעילת טביעת אצבע הופעלה");
                  } catch (e) {
                    showToast("לא ניתן היה להפעיל טביעת אצבע במכשיר הזה");
                  }
                  markPromptedBiometric();
                  setBiometricPrompt(false);
                }}
                className="p-3 rounded-2xl font-bold wh-display"
                style={{ background: C.ink, color: C.paper }}
              >
                כן, הפעל
              </button>
              <button
                onClick={() => { markPromptedBiometric(); setBiometricPrompt(false); }}
                className="p-2 rounded-2xl text-sm"
                style={{ color: C.steel }}
              >
                אולי מאוחר יותר
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick, badge, badgeColor }) {
  return (
    <button
      onClick={onClick}
      className="relative flex-1 py-3 wh-display text-sm font-bold"
      style={{ color: active ? "#fff" : "#9AA69E", borderTop: active ? `2px solid #fff` : "2px solid transparent" }}
    >
      {label}
      {badge && (
        <span
          className="absolute top-1 left-1/2 translate-x-3 rounded-full text-[10px] px-1.5 py-0.5 font-bold"
          style={{ background: badgeColor, color: "#fff", minWidth: 16 }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function DrawerItem({ label, active, onClick, badge, badgeColor }) {
  return (
    <button
      onClick={onClick}
      className="relative flex items-center justify-between px-4 py-3 rounded-2xl wh-display text-sm font-bold text-right"
      style={{
        background: active ? C.ink : "transparent",
        color: active ? "#fff" : C.ink,
      }}
    >
      <span>{label}</span>
      {badge && (
        <span
          className="rounded-full text-[10px] px-1.5 py-0.5 font-bold"
          style={{ background: badgeColor, color: "#fff", minWidth: 16 }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

/* ---------- Dashboard (home screen) ---------- */
function DonutChart({ segments, total, size = 150 }) {
  const stroke = 26;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={C.kraft} strokeWidth={stroke} />
      {total > 0 &&
        segments.map((seg, i) => {
          if (seg.value === 0) return null;
          const len = (seg.value / total) * circ;
          const el = (
            <circle
              key={i}
              cx={cx}
              cy={cx}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cx})`}
            />
          );
          offset += len;
          return el;
        })}
      <text x={cx} y={cx - 4} textAnchor="middle" className="wh-display" style={{ fontSize: 30, fontWeight: 900, fill: C.ink }}>
        {total}
      </text>
      <text x={cx} y={cx + 16} textAnchor="middle" style={{ fontSize: 11, fill: C.steel }}>
        סה"כ משימות
      </text>
    </svg>
  );
}

function Dashboard({ tasks, products, orderHistory, users, currentUser, unitRequests, onGoTo }) {
  const now = Date.now();

  const open = tasks.filter((t) => t.status !== "done");
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const newTasks = tasks.filter((t) => t.status !== "done" && t.status !== "in_progress");
  const done = tasks.filter((t) => t.status === "done");
  const urgent = open.filter((t) => t.priority === "urgent");
  const overdueFollowups = tasks.filter((t) => t.followUpAt && t.followUpAt < now && t.status !== "done");
  const lowStock = products.filter((p) => Number(p.quantity) <= Number(p.threshold));
  const pendingUnit = (unitRequests || []).filter((r) => r.status === "submitted");

  // week's orders
  const weekAgo = now - 7 * 86400000;
  const weekOrders = (orderHistory || []).filter((o) => o.createdAt >= weekAgo);
  const weekSpend = weekOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);

  const statusSegments = [
    { label: "חדש", value: newTasks.length, color: C.accent },
    { label: "בטיפול", value: inProgress.length, color: C.mustard },
    { label: "הושלם", value: done.length, color: C.sage },
  ];

  // by category
  const byCat = {};
  open.forEach((t) => {
    const key = t.categoryId || "none";
    byCat[key] = (byCat[key] || 0) + 1;
  });

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "בוקר טוב";
    if (h < 17) return "צהריים טובים";
    if (h < 21) return "ערב טוב";
    return "לילה טוב";
  })();

  return (
    <div>
      <div className="mb-4">
        <div className="wh-display font-black text-xl" style={{ color: C.ink }}>
          {greeting}, {currentUser.name} 👋
        </div>
        <div className="text-sm" style={{ color: C.steel }}>
          {new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}
        </div>
      </div>

      {/* Alert row */}
      {(urgent.length > 0 || overdueFollowups.length > 0 || pendingUnit.length > 0) && (
        <div className="flex flex-col gap-2 mb-4">
          {urgent.length > 0 && (
            <button onClick={() => onGoTo("tasks")} className="w-full p-3 rounded-2xl text-right flex items-center gap-3" style={{ background: "#FDECEC", border: `1px solid ${C.stamp}` }}>
              <span className="text-xl">⚠️</span>
              <span className="text-sm font-bold" style={{ color: C.stamp }}>{urgent.length} משימות דחופות פתוחות</span>
            </button>
          )}
          {overdueFollowups.length > 0 && (
            <button onClick={() => onGoTo("tasks")} className="w-full p-3 rounded-2xl text-right flex items-center gap-3" style={{ background: "#FFF4E5", border: `1px solid ${C.mustard}` }}>
              <span className="text-xl">⏰</span>
              <span className="text-sm font-bold" style={{ color: C.ink }}>{overdueFollowups.length} תזכורות המשך באיחור</span>
            </button>
          )}
          {pendingUnit.length > 0 && currentUser.role === "manager" && (
            <button onClick={() => onGoTo("admin")} className="w-full p-3 rounded-2xl text-right flex items-center gap-3" style={{ background: "#EFEAFF", border: `1px solid ${C.accent}` }}>
              <span className="text-xl">🧺</span>
              <span className="text-sm font-bold" style={{ color: C.ink }}>{pendingUnit.length} בקשות מהמחסן ממתינות</span>
            </button>
          )}
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <button onClick={() => onGoTo("tasks")} className="text-right">
          <DashCard icon="📋" label="משימות פתוחות" value={open.length} color={C.mustard} />
        </button>
        <button onClick={() => onGoTo("tasks")} className="text-right">
          <DashCard icon="✅" label="הושלמו" value={done.length} color={C.sage} />
        </button>
        <button onClick={() => onGoTo("order")} className="text-right">
          <DashCard icon="🛒" label="מוצרים בחוסר" value={lowStock.length} color={lowStock.length > 0 ? C.stamp : C.sage} />
        </button>
        <button onClick={() => onGoTo("order")} className="text-right">
          <DashCard icon="📦" label="הזמנות השבוע" value={weekOrders.length} sub={`₪${weekSpend.toFixed(0)}`} color={C.accent} />
        </button>
      </div>

      {/* Status donut */}
      <ShelfTag accent={C.ink} style={{ marginBottom: 16 }}>
        <div className="wh-display font-bold text-sm mb-3" style={{ color: C.ink }}>סטטוס משימות</div>
        <div className="flex items-center gap-4">
          <DonutChart segments={statusSegments} total={tasks.length} />
          <div className="flex-1 flex flex-col gap-2">
            {statusSegments.map((s) => {
              const pct = tasks.length ? Math.round((s.value / tasks.length) * 100) : 0;
              return (
                <div key={s.label} className="flex items-center gap-2">
                  <span style={{ width: 12, height: 12, borderRadius: 6, background: s.color, display: "inline-block" }} />
                  <span className="text-sm flex-1" style={{ color: C.ink }}>{s.label}</span>
                  <span className="text-sm font-bold" style={{ color: C.ink }}>{s.value}</span>
                  <span className="text-xs" style={{ color: C.steel }}>({pct}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      </ShelfTag>

      {/* By category */}
      {Object.keys(byCat).length > 0 && (
        <ShelfTag accent={C.accent}>
          <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>משימות פתוחות לפי קטגוריה</div>
          <div className="flex flex-col gap-1.5">
            {Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([catId, count]) => {
              const cat = catId === "none" ? null : (window.__taskCats || []).find((c) => c.id === catId);
              const name = cat ? `${cat.icon || "📋"} ${cat.name}` : "ללא קטגוריה";
              const col = cat ? categoryColor(cat.name) : C.steel;
              const max = Math.max(...Object.values(byCat));
              return (
                <div key={catId}>
                  <div className="flex justify-between text-sm mb-0.5">
                    <span style={{ color: C.ink }}>{name}</span>
                    <span className="font-bold" style={{ color: C.ink }}>{count}</span>
                  </div>
                  <div className="rounded-full overflow-hidden" style={{ background: C.kraft, height: 6 }}>
                    <div style={{ background: col, height: "100%", width: `${(count / max) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </ShelfTag>
      )}
    </div>
  );
}

function DashCard({ icon, label, value, sub, color }) {
  return (
    <div className="rounded-2xl p-3" style={{ background: "#fff", border: `1px solid ${C.kraftDark}`, borderTop: `4px solid ${color}`, boxShadow: "0 2px 8px rgba(20,33,61,0.05)" }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs" style={{ color: C.steel }}>{label}</span>
        <span className="text-lg">{icon}</span>
      </div>
      <div className="wh-display font-black" style={{ color, fontSize: 30 }}>{value}</div>
      {sub && <div className="text-xs" style={{ color: C.steel }}>{sub}</div>}
    </div>
  );
}

/* ---------- Inventory Tab ---------- */
function InventoryTab({ products, persistProducts, openScanner, scanResult, clearScanResult, currentUser, showToast, isManager, logStockChange }) {
  const [search, setSearch] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const [viewMode, setViewMode] = useState("category"); // "category" | "name"
  const [activeCategory, setActiveCategory] = useState("all"); // "all" | specific category name
  const filtered = products.filter((p) => p.name.includes(search) || p.barcode.includes(search));
  const filteredByCategory =
    activeCategory === "all" ? filtered : filtered.filter((p) => (p.category || "ללא קטגוריה") === activeCategory);

  const allCategories = Array.from(
    new Set(products.map((p) => p.category || "ללא קטגוריה"))
  );

  async function adjustQty(product, delta) {
    const next = products.map((p) =>
      p.id === product.id ? { ...p, quantity: Math.max(0, Number(p.quantity) + delta) } : p
    );
    await persistProducts(next);
    if (logStockChange) logStockChange(product.id, delta, currentUser.name);
    showToast(`${product.name}: ${delta > 0 ? "+" : ""}${delta} (${currentUser.name})`);
  }

  async function setQty(product, newQty) {
    const next = products.map((p) => (p.id === product.id ? { ...p, quantity: newQty } : p));
    await persistProducts(next);
    const delta = Number(newQty) - Number(product.quantity);
    if (logStockChange) logStockChange(product.id, delta, currentUser.name);
    showToast(`${product.name}: עודכן ל-${newQty} (${currentUser.name})`);
  }

  const summaryByCategory = Object.entries(
    products.reduce((acc, p) => {
      const cat = p.category || "ללא קטגוריה";
      if (!acc[cat]) acc[cat] = { count: 0, value: 0, low: 0 };
      acc[cat].count += 1;
      acc[cat].value += Number(p.price) * Number(p.quantity);
      if (Number(p.quantity) <= Number(p.threshold)) acc[cat].low += 1;
      return acc;
    }, {})
  );
  const totalValue = products.reduce((sum, p) => sum + Number(p.price) * Number(p.quantity), 0);
  const totalLow = products.filter((p) => Number(p.quantity) <= Number(p.threshold)).length;

  return (
    <div>
      <button
        onClick={() => setShowSummary((v) => !v)}
        className="w-full py-2 mb-4 rounded-2xl font-bold text-sm wh-display"
        style={{ background: C.ink, color: C.paper }}
      >
        {showSummary ? "▲ הסתר סיכום מלאי" : "📊 הצג סיכום מלאי"}
      </button>

      {showSummary && (
        <ShelfTag accent={C.steel} style={{ marginBottom: 16 }}>
          <div className="flex justify-between mb-3 pb-2" style={{ borderBottom: `1px solid ${C.kraftDark}` }}>
            <div className="text-center flex-1">
              <div className="wh-display font-black text-xl" style={{ color: C.ink }}>{products.length}</div>
              <div className="text-xs" style={{ color: C.steel }}>מוצרים</div>
            </div>
            <div className="text-center flex-1">
              <div className="wh-display font-black text-xl" style={{ color: C.ink }}>₪{totalValue.toFixed(0)}</div>
              <div className="text-xs" style={{ color: C.steel }}>ערך מלאי כולל</div>
            </div>
            <div className="text-center flex-1">
              <div className="wh-display font-black text-xl" style={{ color: totalLow > 0 ? C.stamp : C.sage }}>{totalLow}</div>
              <div className="text-xs" style={{ color: C.steel }}>מתחת לסף</div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {summaryByCategory.map(([cat, s]) => (
              <div key={cat} className="flex justify-between items-center text-sm">
                <span style={{ color: C.ink }} className="font-bold">{cat}</span>
                <span style={{ color: C.steel }}>
                  {s.count} מוצרים · ₪{s.value.toFixed(0)}
                  {s.low > 0 && <span style={{ color: C.stamp }}> · {s.low} בחוסר</span>}
                </span>
              </div>
            ))}
          </div>
        </ShelfTag>
      )}

      <div className="flex gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש מוצר..."
          className="flex-1 p-3 rounded-2xl border"
          style={{ borderColor: C.kraftDark, background: "#fff" }}
        />
        <button
          onClick={openScanner}
          className="px-4 rounded-2xl wh-display font-bold"
          style={{ background: C.ink, color: C.paper }}
        >
          📷 סרוק
        </button>
      </div>

      {scanResult && (
        <ScanResultCard
          scanResult={scanResult}
          products={products}
          onAdjust={adjustQty}
          onClose={clearScanResult}
          isManager={isManager}
        />
      )}

      {activeCategory === "all" && (
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setViewMode("category")}
            className="flex-1 py-2 rounded-2xl text-sm font-bold"
            style={{ background: viewMode === "category" ? C.ink : C.kraft, color: viewMode === "category" ? C.paper : C.ink }}
          >
            לפי קטגוריה
          </button>
          <button
            onClick={() => setViewMode("name")}
            className="flex-1 py-2 rounded-2xl text-sm font-bold"
            style={{ background: viewMode === "name" ? C.ink : C.kraft, color: viewMode === "name" ? C.paper : C.ink }}
          >
            לפי שם (רשימה)
          </button>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-2 mb-3" style={{ scrollbarWidth: "thin" }}>
        <button
          onClick={() => setActiveCategory("all")}
          className="px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap"
          style={{ background: activeCategory === "all" ? C.ink : C.kraft, color: activeCategory === "all" ? "#fff" : C.ink, border: `1px solid ${C.kraftDark}` }}
        >
          הכל
        </button>
        {allCategories.map((cat) => {
          const col = categoryColor(cat);
          const active = activeCategory === cat;
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className="px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap"
              style={{
                background: active ? col : "#fff",
                color: active ? "#fff" : col,
                border: `1.5px solid ${col}`,
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-4">
        {filteredByCategory.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: C.steel }}>
            אין מוצרים להצגה. {isManager ? "הוסף מוצרים במסך ניהול." : ""}
          </p>
        )}
        {viewMode === "name" || activeCategory !== "all" ? (
          <div className="flex flex-col gap-3">
            {[...filteredByCategory].sort((a, b) => a.name.localeCompare(b.name, "he")).map((p) => (
              <ProductCard key={p.id} p={p} onSetQty={setQty} />
            ))}
          </div>
        ) : (
          Object.entries(
            filteredByCategory.reduce((acc, p) => {
              const cat = p.category || "ללא קטגוריה";
              (acc[cat] = acc[cat] || []).push(p);
              return acc;
            }, {})
          ).map(([cat, items]) => (
            <div key={cat}>
              <div className="wh-display font-bold text-sm mb-2" style={{ color: C.steel }}>{cat} ({items.length})</div>
              <div className="flex flex-col gap-3">
                {items.map((p) => (
                  <ProductCard key={p.id} p={p} onSetQty={setQty} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ProductCard({ p, onSetQty }) {
  const low = Number(p.quantity) <= Number(p.threshold);
  const [value, setValue] = useState(p.quantity);

  useEffect(() => { setValue(p.quantity); }, [p.quantity]);

  const changed = Number(value) !== Number(p.quantity);

  return (
    <ShelfTag accent={low ? C.stamp : C.sage}>
      <div className="flex justify-between items-start">
        <div className="flex gap-2">
          {p.imageData && (
            <img src={p.imageData} alt="" className="rounded-xl flex-shrink-0" style={{ width: 56, height: 56, objectFit: "cover" }} />
          )}
          <div>
            <div className="wh-display font-bold" style={{ color: C.ink }}>{p.name}</div>
            <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>
              ברקוד: {p.barcode || "—"}
            </div>
            <div className="text-xs mt-1" style={{ color: C.steel }}>
              ₪{Number(p.price).toFixed(2)} ליחידה · סף מינ׳ {p.threshold} {p.unit}
              {p.unitsPerCarton > 0 && ` · ${p.unitsPerCarton} ביחידה בקרטון`}
            </div>
          </div>
        </div>
        <div className="text-left">
          <div className="wh-display font-black text-2xl" style={{ color: low ? C.stamp : C.ink }}>
            {p.quantity}
          </div>
          <div className="text-xs" style={{ color: C.steel }}>{p.unit}</div>
        </div>
      </div>
      <div className="flex gap-2 mt-3 items-center">
        <label className="text-xs font-bold" style={{ color: C.steel }}>כמות סופית:</label>
        <input
          type="number"
          value={value === 0 ? "" : value}
          onChange={(e) => setValue(e.target.value === "" ? 0 : Number(e.target.value))}
          className="w-20 text-center p-2 rounded-2xl border"
          style={{ borderColor: C.kraftDark }}
        />
        <button
          onClick={() => onSetQty(p, Math.max(0, Number(value)))}
          disabled={!changed}
          className="flex-1 py-2 rounded-2xl font-bold"
          style={{
            background: changed ? C.sage : C.kraft,
            color: changed ? "#fff" : C.steel,
            cursor: changed ? "pointer" : "default",
          }}
        >
          עדכן
        </button>
      </div>
    </ShelfTag>
  );
}

function ScanResultCard({ scanResult, onAdjust, onClose, isManager }) {
  const [qty, setQty] = useState(1);
  const { code, product } = scanResult;

  if (!product) {
    return (
      <ShelfTag accent={C.stamp} style={{ marginBottom: 16 }}>
        <div className="wh-display font-bold" style={{ color: C.stamp }}>מוצר לא נמצא</div>
        <div className="text-xs my-1" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>
          ברקוד שנסרק: {code}
        </div>
        {isManager && (
          <p className="text-xs mb-2" style={{ color: C.steel }}>
            אפשר להוסיף מוצר חדש עם הברקוד הזה במסך ניהול.
          </p>
        )}
        <button onClick={onClose} className="w-full py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
          סגור
        </button>
      </ShelfTag>
    );
  }

  return (
    <ShelfTag accent={C.sage} style={{ marginBottom: 16 }}>
      <div className="wh-display font-bold" style={{ color: C.ink }}>{product.name}</div>
      <div className="text-xs mb-2" style={{ color: C.steel }}>מלאי נוכחי: {product.quantity} {product.unit}</div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="px-3 py-1 rounded-2xl" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>−</button>
        <input
          type="number"
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
          className="w-16 text-center p-1 rounded-2xl border"
          style={{ borderColor: C.kraftDark }}
        />
        <button onClick={() => setQty((q) => q + 1)} className="px-3 py-1 rounded-2xl" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>+</button>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => { onAdjust(product, -qty); onClose(); }}
          className="flex-1 py-2 rounded-2xl font-bold"
          style={{ background: C.stamp, color: "#fff" }}
        >
          הורד מלאי
        </button>
        <button
          onClick={() => { onAdjust(product, qty); onClose(); }}
          className="flex-1 py-2 rounded-2xl font-bold"
          style={{ background: C.sage, color: "#fff" }}
        >
          הוסף למלאי
        </button>
      </div>
      <button onClick={onClose} className="w-full mt-2 py-1 text-xs" style={{ color: C.steel }}>ביטול</button>
    </ShelfTag>
  );
}

/* ---------- Order Tab ---------- */
function useHebrewHolidays() {
  const [holidays, setHolidays] = useState([]);
  const [loadingHolidays, setLoadingHolidays] = useState(true);

  useEffect(() => {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 90);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&start=${fmt(start)}&end=${fmt(end)}&lg=he`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        const items = (data.items || [])
          .filter((it) => it.category === "holiday")
          .map((it) => ({ date: it.date, title: it.hebrew || it.title }));
        setHolidays(items);
      })
      .catch(() => setHolidays([]))
      .finally(() => setLoadingHolidays(false));
  }, []);

  return { holidays, loadingHolidays };
}

/** Weekly Torah portions from Hebcal, keyed by the Shabbat they're read on. */
function useParshiot() {
  const [parshiot, setParshiot] = useState([]);

  useEffect(() => {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    const end = new Date();
    end.setDate(end.getDate() + 120);
    const fmt = (d) => d.toISOString().slice(0, 10);
    // s=on adds the weekly parasha to the results.
    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&s=on&start=${fmt(start)}&end=${fmt(end)}&lg=he`;

    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        const items = (data.items || [])
          .filter((it) => it.category === "parashat")
          .map((it) => ({ date: it.date.slice(0, 10), title: it.hebrew || it.title }));
        setParshiot(items);
      })
      .catch(() => setParshiot([]));
  }, []);

  return parshiot;
}

/** The Saturday that closes the week starting on the given Sunday. */
function shabbatOfWeek(weekStartIsoStr) {
  const d = new Date(weekStartIsoStr);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** ISO Sunday of next week. */
function nextWeekStartIso() {
  const d = new Date(weekStartIso());
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function HebrewCalendarWidget() {
  const { holidays, loadingHolidays } = useHebrewHolidays();
  const [open, setOpen] = useState(false);

  function formatHebrewDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("he-IL", { weekday: "short", day: "numeric", month: "short" });
    } catch (e) {
      return iso;
    }
  }

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full py-2 rounded-2xl font-bold text-sm"
        style={{ background: C.accent2, color: "#fff" }}
      >
        📅 חגים ואירועים קרובים בלוח העברי {open ? "▲" : "▼"}
      </button>
      {open && (
        <ShelfTag accent={C.accent2} style={{ marginTop: 8 }}>
          {loadingHolidays ? (
            <p className="text-sm text-center" style={{ color: C.steel }}>טוען...</p>
          ) : holidays.length === 0 ? (
            <p className="text-sm text-center" style={{ color: C.steel }}>לא נמצאו אירועים קרובים</p>
          ) : (
            <div className="flex flex-col gap-2">
              {holidays.map((h, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="font-bold" style={{ color: C.ink }}>{h.title}</span>
                  <span style={{ color: C.steel }}>{formatHebrewDate(h.date)}</span>
                </div>
              ))}
            </div>
          )}
        </ShelfTag>
      )}
    </div>
  );
}

function OrderTab({ lowStock, products, settings, persistSettings, isManager, menuItems, weeklyMenu, persistWeeklyMenu, showToast, dishTypes, currentUser, orderRequests, persistOrderRequests, notifyManagers }) {
  const mayApprove = canSendOrders(currentUser);
  const myPending = (orderRequests || []).filter((r) => r.createdById === currentUser?.id && r.status === "pending");
  const suppliers = settings.suppliers || [];
  const [selectedSupplierId, setSelectedSupplierId] = useState(suppliers[0]?.id || "");
  const [manualPhone, setManualPhone] = useState(settings.supplierPhone || "");
  const [manualEmail, setManualEmail] = useState(settings.supplierEmail || "");
  const [channel, setChannel] = useState("whatsapp"); // "whatsapp" | "sms" | "email"
  const [orderMode, setOrderMode] = useState("stock"); // "stock" | "menu" | "week"
  const [qtys, setQtys] = useState(() =>
    Object.fromEntries(lowStock.map((p) => [p.id, Math.max(1, Number(p.threshold) * 2 - Number(p.quantity))]))
  );
  const [selectedMenuIds, setSelectedMenuIds] = useState([]);
  const [portions, setPortions] = useState(1);
  const [weekPortions, setWeekPortions] = useState(1);
  const [menuQtys, setMenuQtys] = useState({});
  const [weekQtys, setWeekQtys] = useState({});
  const [pickedIds, setPickedIds] = useState([]);        // which computed needs go on the order
  const [orderExtras, setOrderExtras] = useState({});    // productId -> qty, for items NOT in the menu
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [extraSearch, setExtraSearch] = useState("");
  const [pendingOrder, setPendingOrder] = useState(null); // review sheet before anything is sent
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSupplierFilter, setOrderSupplierFilter] = useState("all");
  const [selectedForOrder, setSelectedForOrder] = useState([]);
  const [openPicker, setOpenPicker] = useState(null);
  const [weekView, setWeekView] = useState("grid"); // "grid" (like the Excel sheet) | "days"
  const [menuWeek, setMenuWeek] = useState("next"); // which week the printed menu is for
  const [parshaOverride, setParshaOverride] = useState("");
  const parshiot = useParshiot();

  // The menu you plan is normally for the coming week, so that's the default.
  const targetWeekStart = menuWeek === "next" ? nextWeekStartIso() : weekStartIso();
  const targetShabbat = shabbatOfWeek(targetWeekStart);
  const autoParsha = parshiot.find((p) => p.date === targetShabbat)?.title || "";
  const parshaTitle = parshaOverride.trim() || autoParsha;
  const { holidays } = useHebrewHolidays();

  function dateForWeekdayIndex(idx) {
    const now = new Date();
    const diff = idx - now.getDay();
    const d = new Date(now);
    d.setDate(now.getDate() + diff);
    return d;
  }
  function holidayForDate(d) {
    const iso = d.toISOString().slice(0, 10);
    return holidays.find((h) => h.date.slice(0, 10) === iso);
  }

  useEffect(() => {
    setQtys(Object.fromEntries(lowStock.map((p) => [p.id, qtys[p.id] ?? Math.max(1, Number(p.threshold) * 2 - Number(p.quantity))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowStock.length]);

  // Deliberately no auto-selection: the user decides what actually goes on the order.
  // (Previously every low-stock item was pre-ticked, which made it easy to send things
  // nobody meant to order.) The "סמן הכל" button is there when you do want them all.

  function toggleMenuItem(id) {
    setSelectedMenuIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function setWeekSlot(day, slot, dishType, menuItemId) {
    const daySlots = weeklyMenu[day] || {};
    const slotTypes = daySlots[slot] || {};
    const next = {
      ...weeklyMenu,
      [day]: { ...daySlots, [slot]: { ...slotTypes, [dishType]: menuItemId || null } },
    };
    await persistWeeklyMenu(next);
  }

  // Compute what's needed for the selected menu items (x portions) minus current stock
  const menuNeeds = (() => {
    const needed = {}; // productId -> total qty needed
    menuItems
      .filter((m) => selectedMenuIds.includes(m.id))
      .forEach((m) => {
        m.ingredients.forEach((ing) => {
          needed[ing.productId] = (needed[ing.productId] || 0) + ing.qty * Number(portions || 1);
        });
      });
    return Object.entries(needed)
      .map(([productId, totalNeeded]) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return null;
        const deficit = Math.max(0, totalNeeded - Number(product.quantity));
        return { product, totalNeeded, deficit };
      })
      .filter(Boolean);
  })();

  // Compute needs for the entire week's plan (every filled slot/dish-type, once each, times weekPortions)
  const weekNeeds = (() => {
    const needed = {};
    const chosenDishNames = [];
    WEEK_DAYS.forEach(([dayKey]) => {
      MEAL_SLOTS.forEach(([slotKey]) => {
        (dishTypes || []).forEach((dt) => {
          const menuItemId = weeklyMenu[dayKey]?.[slotKey]?.[dt.id];
          if (!menuItemId) return;
          const m = menuItems.find((mi) => mi.id === menuItemId);
          if (!m) return;
          chosenDishNames.push(m.name);
          m.ingredients.forEach((ing) => {
            needed[ing.productId] = (needed[ing.productId] || 0) + ing.qty * Number(weekPortions || 1);
          });
        });
      });
    });
    const rows = Object.entries(needed)
      .map(([productId, totalNeeded]) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return null;
        const deficit = Math.max(0, totalNeeded - Number(product.quantity));
        return { product, totalNeeded, deficit };
      })
      .filter(Boolean);
    return { rows, chosenDishNames };
  })();

  function getQty(store, product, deficit) {
    return store[product.id] ?? deficit;
  }

  function togglePicked(id) {
    setPickedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  /* The order = the needs you actually ticked + anything you added manually.
     Nothing is ticked by default: a product only ships if you chose it. */
  function buildOrderRows(needs, qtyStore) {
    const rows = needs
      .filter((n) => pickedIds.includes(n.product.id))
      .map((n) => ({ product: n.product, qty: getQty(qtyStore, n.product, n.deficit) }));

    Object.entries(orderExtras).forEach(([pid, qty]) => {
      if (rows.some((r) => r.product.id === pid)) return; // already covered by the menu
      const product = products.find((p) => p.id === pid);
      if (product && Number(qty) > 0) rows.push({ product, qty: Number(qty) });
    });

    return rows.filter((r) => Number(r.qty) > 0);
  }

  function groupRowsBySupplier(rows) {
    const groups = {};
    rows.forEach((r) => {
      const key = r.product.supplierId || "__unassigned__";
      (groups[key] = groups[key] || []).push(r);
    });
    return groups;
  }

  function buildStockMessage() {
    const lines = products
      .filter((p) => selectedForOrder.includes(p.id))
      .map((p) => ({ p, qty: qtys[p.id] ?? 1 }))
      .filter(({ qty }) => Number(qty) > 0)
      .map(({ p, qty }) => `- ${qty} ${p.unit} ${p.name}`);
    return lines.join("\n");
  }

  const ORDER_SUBJECT = `הזמנת מלאי — ${todayStr()}`;

  function resolvedPhone() {
    if (selectedSupplierId === "__manual__") return manualPhone;
    const s = suppliers.find((s) => s.id === selectedSupplierId);
    return s?.phone || manualPhone;
  }

  function resolvedEmail() {
    if (selectedSupplierId === "__manual__") return manualEmail;
    const s = suppliers.find((s) => s.id === selectedSupplierId);
    return s?.email || manualEmail;
  }

  async function sendOrder() {
    if (selectedForOrder.length === 0) {
      if (showToast) showToast("סמן קודם לפחות מוצר אחד לשליחה");
      return;
    }
    const items = products
      .filter((p) => selectedForOrder.includes(p.id))
      .map((p) => ({ product: p, qty: qtys[p.id] ?? 1 }))
      .filter(({ qty }) => Number(qty) > 0);

    if (items.length === 0) {
      showToast("אין מוצרים עם כמות גדולה מאפס");
      return;
    }
    // Same rule as the menu modes: only a manager sends straight to the supplier.
    // Anyone else raises a request for approval. (This used to bypass approval.)
    setPendingOrder({
      items,
      title: "לפי סף מלאי",
      supplierId: selectedSupplierId === "__manual__" ? "__unassigned__" : selectedSupplierId,
      isRequest: !mayApprove,
      sourceLabel: "לפי סף מלאי",
    });
  }

  // Group a set of rows (product + qty) by the product's assigned supplier.
  // Rows for products with no assigned supplier fall under "__unassigned__".


  /** Non-managers can't push an order to a supplier - they file it for approval instead. */
  async function submitOrderRequest(items, supplierId, sourceLabel) {
    const rows = items
      .map(({ product, qty }) => ({
        productId: product.id,
        name: product.name,
        unit: product.unit,
        qty: Number(qty),
        supplierId: product.supplierId || supplierId || "",
      }))
      .filter((r) => r.qty > 0);

    if (rows.length === 0) {
      showToast("אין מוצרים עם כמות לשליחה");
      return;
    }

    const request = {
      id: genId(),
      createdAt: Date.now(),
      createdById: currentUser.id,
      createdByName: currentUser.name,
      status: "pending",
      source: sourceLabel,
      suggestedSupplierId: supplierId && supplierId !== "__unassigned__" ? supplierId : "",
      items: rows,
    };

    await persistOrderRequests([...(orderRequests || []), request]);
    if (notifyManagers) {
      await notifyManagers(`📦 ${currentUser.name} שלח בקשת הזמנה (${rows.length} מוצרים) - ממתינה לאישורך`, { tab: "admin", section: "orderrequests" });
    }
    showToast("הבקשה נשלחה למנהל לאישור ✓");
  }

  /* Shared by "לפי מנות בודדות" and "לפי תפריט שבועי": manually added products
     that the menu calculation knows nothing about (ketchup, napkins, a one-off). */
  function ExtrasPanel() {
    const extraRows = Object.entries(orderExtras)
      .map(([pid, qty]) => ({ product: products.find((p) => p.id === pid), qty }))
      .filter((r) => r.product);

    const pickable = products
      .filter((p) => !orderExtras[p.id])
      .filter((p) => !extraSearch || p.name.includes(extraSearch));

    return (
      <div className="mb-4">
        <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>
          ➕ תוספות להזמנה (מחוץ לתפריט)
        </div>

        {extraRows.length > 0 && (
          <div className="flex flex-col gap-2 mb-2">
            {extraRows.map(({ product, qty }) => (
              <ShelfTag key={product.id} accent={C.mustard}>
                <div className="flex justify-between items-center text-sm">
                  <div>
                    <div className="font-bold" style={{ color: C.ink }}>{product.name}</div>
                    <div className="text-xs" style={{ color: C.steel }}>
                      יש במלאי {product.quantity} {product.unit}
                      {product.supplierId && ` · ספק: ${suppliers.find((s) => s.id === product.supplierId)?.name || "—"}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={Number(qty) === 0 ? "" : qty}
                      onChange={(e) =>
                        setOrderExtras((cur) => ({ ...cur, [product.id]: Math.max(0, Number(e.target.value) || 0) }))
                      }
                      className="w-16 text-center p-2 rounded-2xl border"
                      style={{ borderColor: C.kraftDark }}
                    />
                    <button
                      onClick={() =>
                        setOrderExtras((cur) => {
                          const next = { ...cur };
                          delete next[product.id];
                          return next;
                        })
                      }
                      className="px-2 py-1 rounded-xl text-xs font-bold"
                      style={{ background: C.stamp, color: "#fff" }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </ShelfTag>
            ))}
          </div>
        )}

        <button
          onClick={() => setExtrasOpen(true)}
          className="w-full py-2 rounded-2xl font-bold text-sm"
          style={{ background: "#fff", color: C.mustard, border: `1.5px dashed ${C.mustard}` }}
        >
          ➕ הוסף מוצר שלא בתפריט
        </button>

        {extrasOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end"
            style={{ background: "rgba(35,31,61,0.5)" }}
            onClick={() => setExtrasOpen(false)}
          >
            <div
              className="w-full wh-body"
              style={{ background: C.paper, borderRadius: "24px 24px 0 0", maxHeight: "80vh", overflowY: "auto", padding: 16 }}
              onClick={(e) => e.stopPropagation()}
              dir="rtl"
            >
              <div className="flex justify-between items-center mb-3">
                <div className="wh-display font-bold" style={{ color: C.ink }}>הוסף מוצר להזמנה</div>
                <button onClick={() => setExtrasOpen(false)} className="px-3 py-1 rounded-full text-sm font-bold" style={{ background: C.ink, color: "#fff" }}>
                  סיימתי
                </button>
              </div>

              <input
                value={extraSearch}
                onChange={(e) => setExtraSearch(e.target.value)}
                placeholder="חיפוש מוצר..."
                className="w-full p-3 rounded-2xl border mb-3"
                style={{ borderColor: C.kraftDark, background: "#fff" }}
                autoFocus
              />

              {pickable.length === 0 ? (
                <p className="text-sm text-center py-6" style={{ color: C.steel }}>אין מוצרים תואמים</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {pickable.map((p) => {
                    // Suggest topping back up to twice the threshold, like the stock screen does.
                    const suggested = Math.max(1, Number(p.threshold) * 2 - Number(p.quantity));
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          setOrderExtras((cur) => ({ ...cur, [p.id]: suggested }));
                          setExtraSearch("");
                        }}
                        className="flex justify-between items-center p-3 rounded-2xl text-right"
                        style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}
                      >
                        <div>
                          <div className="font-bold text-sm" style={{ color: C.ink }}>{p.name}</div>
                          <div className="text-xs" style={{ color: C.steel }}>
                            {p.category || "ללא קטגוריה"} · יש {p.quantity} {p.unit}
                          </div>
                        </div>
                        <span className="text-lg font-bold" style={{ color: C.sage }}>+</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  /* Every send path funnels through here first. Shows exactly what's going out,
     to whom, on which channel, with the real message text - then sends. */
  function OrderSummarySheet() {
    if (!pendingOrder) return null;
    const { items, supplierId, title, isRequest } = pendingOrder;

    const supplierName =
      supplierId && supplierId !== "__unassigned__"
        ? suppliers.find((s) => s.id === supplierId)?.name || "ספק"
        : "ספק כללי";

    let dest = "";
    if (supplierId && supplierId !== "__unassigned__") {
      const sup = suppliers.find((s) => s.id === supplierId);
      dest = channel === "email" ? sup?.email || "" : sup?.phone || "";
    } else {
      dest = channel === "email" ? resolvedEmail() : resolvedPhone();
    }

    const total = items.reduce((sum, { product, qty }) => sum + Number(product.price || 0) * Number(qty), 0);
    const messageText = items.map(({ product, qty }) => `- ${qty} ${product.unit} ${product.name}`).join("\n");
    const missingDest = !isRequest && !dest;

    return (
      <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(35,31,61,0.55)" }} onClick={() => setPendingOrder(null)}>
        <div
          className="w-full wh-body"
          style={{ background: C.paper, borderRadius: "24px 24px 0 0", maxHeight: "88vh", overflowY: "auto", padding: 16 }}
          onClick={(e) => e.stopPropagation()}
          dir="rtl"
        >
          <div className="flex justify-between items-start mb-3">
            <div>
              <div className="wh-display font-black text-lg" style={{ color: C.ink }}>
                {isRequest ? "סיכום בקשת הזמנה" : "סיכום הזמנה"}
              </div>
              <div className="text-xs" style={{ color: C.steel }}>{title}</div>
            </div>
            <button onClick={() => setPendingOrder(null)} className="px-3 py-1 rounded-full text-sm font-bold" style={{ background: C.kraft, color: C.ink }}>
              ביטול
            </button>
          </div>

          {/* Where it's going */}
          <ShelfTag accent={missingDest ? C.stamp : C.accent} style={{ marginBottom: 12 }}>
            <div className="flex justify-between text-sm">
              <span style={{ color: C.steel }}>ספק:</span>
              <b style={{ color: C.ink }}>{supplierName}</b>
            </div>
            {!isRequest && (
              <>
                <div className="flex justify-between text-sm mt-1">
                  <span style={{ color: C.steel }}>ערוץ:</span>
                  <b style={{ color: channelMeta(channel).color }}>
                    {channelMeta(channel).icon} {channelMeta(channel).label}
                  </b>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span style={{ color: C.steel }}>יעד:</span>
                  <b style={{ color: missingDest ? C.stamp : C.ink, direction: "ltr" }}>
                    {dest || "לא הוגדר!"}
                  </b>
                </div>
              </>
            )}
            {isRequest && (
              <p className="text-xs mt-2" style={{ color: C.steel }}>
                הבקשה תישלח למנהל לאישור. היא לא יוצאת לספק עדיין.
              </p>
            )}
          </ShelfTag>

          {missingDest && (
            <ShelfTag accent={C.stamp} style={{ marginBottom: 12 }}>
              <p className="text-sm font-bold" style={{ color: C.stamp }}>
                אין {channel === "email" ? "מייל" : "טלפון"} ל{supplierName}
              </p>
              <p className="text-xs" style={{ color: C.steel }}>
                הוסף בניהול ← הגדרות ← ספקים, או החלף ערוץ.
              </p>
            </ShelfTag>
          )}

          {/* Line by line */}
          <div className="rounded-2xl overflow-hidden mb-3" style={{ border: `1px solid ${C.kraftDark}` }}>
            <div className="flex text-xs font-bold px-3 py-2" style={{ background: C.ink, color: "#fff" }}>
              <span className="flex-1">מוצר</span>
              <span style={{ width: 70, textAlign: "center" }}>כמות</span>
              <span style={{ width: 70, textAlign: "left" }}>מחיר</span>
            </div>
            {items.map(({ product, qty }, i) => (
              <div
                key={product.id}
                className="flex items-center px-3 py-2 text-sm"
                style={{ background: i % 2 ? "#F7FAFD" : "#fff", borderTop: `1px solid ${C.kraftDark}` }}
              >
                <span className="flex-1 font-bold" style={{ color: C.ink }}>{product.name}</span>
                <span style={{ width: 70, textAlign: "center", color: C.ink }}>
                  {qty} {product.unit}
                </span>
                <span style={{ width: 70, textAlign: "left", color: C.steel }}>
                  ₪{(Number(product.price || 0) * Number(qty)).toFixed(0)}
                </span>
              </div>
            ))}
            <div className="flex px-3 py-2 text-sm font-bold" style={{ background: "#EFEAFF", borderTop: `2px solid ${C.ink}` }}>
              <span className="flex-1" style={{ color: C.ink }}>סה"כ {items.length} מוצרים</span>
              <span style={{ color: C.ink }}>₪{total.toFixed(0)}</span>
            </div>
          </div>

          {!isRequest && (
            <details className="mb-3">
              <summary className="text-xs font-bold cursor-pointer" style={{ color: C.accent }}>
                תצוגה מקדימה של ההודעה שתישלח
              </summary>
              <pre
                className="text-xs mt-2 p-3 rounded-2xl"
                style={{ background: "#fff", border: `1px solid ${C.kraftDark}`, color: C.ink, whiteSpace: "pre-wrap", fontFamily: "inherit" }}
              >
                {messageText}
              </pre>
            </details>
          )}

          <button
            onClick={() => {
              const p = pendingOrder;
              setPendingOrder(null);
              if (p.isRequest) submitOrderRequest(p.items, p.supplierId, p.sourceLabel);
              else doSendGroupOrder(p.items, p.title, p.supplierId);
            }}
            disabled={missingDest}
            className="w-full py-3 rounded-2xl wh-display font-bold"
            style={{
              background: missingDest ? C.kraftDark : isRequest ? C.accent : channelMeta(channel).color,
              color: "#fff",
              opacity: missingDest ? 0.6 : 1,
            }}
          >
            {isRequest
              ? "📤 שלח בקשה לאישור"
              : `${channelMeta(channel).icon} אשר ושלח ל${supplierName}`}
          </button>

          {!isRequest && (settings?.whatsappGroupLink || "").trim() && (
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(messageText);
                  showToast("ההזמנה הועתקה - הדבק אותה בקבוצה");
                } catch (e) {
                  showToast("פותח את הקבוצה - העתק את ההזמנה מהתצוגה המקדימה");
                }
                window.open(settings.whatsappGroupLink.trim(), "_blank");
                setPendingOrder(null);
              }}
              className="w-full py-3 mt-2 rounded-2xl wh-display font-bold"
              style={{ background: "#128C7E", color: "#fff" }}
            >
              👥 שלח לקבוצת וואטסאפ
            </button>
          )}
        </div>
      </div>
    );
  }

  /* Opens the review sheet. Nothing leaves the app until the user confirms there. */
  function sendGroupOrder(items, title, supplierId) {
    if (!items || items.length === 0) {
      showToast("לא נבחרו מוצרים להזמנה");
      return;
    }
    setPendingOrder({ items, title, supplierId, isRequest: false });
  }

  function doSendGroupOrder(items, title, supplierId) {
    const lines = items.map(({ product, qty }) => `- ${qty} ${product.unit} ${product.name}`);
    let phone = "";
    let email = "";
    if (supplierId && supplierId !== "__unassigned__") {
      const s = suppliers.find((s) => s.id === supplierId);
      phone = s?.phone || "";
      email = s?.email || "";
    } else {
      phone = resolvedPhone();
      email = resolvedEmail();
    }
    const res = sendViaChannel(channel, {
      phone,
      email,
      text: lines.join("\n"),
      subject: title ? `${title} — ${todayStr()}` : ORDER_SUBJECT,
    });
    if (!res.ok) {
      if (showToast) showToast(res.error);
      return;
    }
    if (recordOrder) {
      const supName = supplierId && supplierId !== "__unassigned__"
        ? suppliers.find((s) => s.id === supplierId)?.name || "ספק"
        : "ספק כללי";
      recordOrder({
        kind: "order",
        title: title || "הזמנה",
        channel,
        supplierId: supplierId || null,
        supplierName: supName,
        by: currentUser?.name || "",
        items: items.map(({ product, qty }) => ({ name: product.name, unit: product.unit, qty, price: Number(product.price || 0) })),
        total: items.reduce((sum, { product, qty }) => sum + Number(product.price || 0) * Number(qty), 0),
      });
    }
  }

  /* Print layout mirrors the Excel sheet this replaced:
     rows = dish types (מנה עיקרית / תוספת / ירקנית), columns = days.
     One table per meal slot. */
  function printWeeklyMenu() {
    const days = WEEK_DAYS;
    const types = dishTypes || [];

    function tableFor(slotKey, slotLabel) {
      const header = days
        .map(([, label], idx) => {
          const d = new Date(targetWeekStart);
          d.setDate(d.getDate() + idx);
          const dateStr = d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
          return `<th>${label}<div class="date">${dateStr}</div></th>`;
        })
        .join("");

      const body = types
        .map((dt) => {
          const cells = days
            .map(([dayKey]) => {
              const id = weeklyMenu[dayKey]?.[slotKey]?.[dt.id];
              const m = menuItems.find((mi) => mi.id === id);
              return `<td>${m ? m.name : ""}</td>`;
            })
            .join("");
          return `<tr><th class="rowhead">${dt.name}</th>${cells}</tr>`;
        })
        .join("");

      // Skip a meal slot entirely if nothing was planned for it.
      const anything = days.some(([dayKey]) =>
        types.some((dt) => weeklyMenu[dayKey]?.[slotKey]?.[dt.id])
      );
      if (!anything) return "";

      return `
        <h2>ארוחת ${slotLabel}</h2>
        <table>
          <thead><tr><th class="corner"></th>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>`;
    }

    const tables = MEAL_SLOTS.map(([k, l]) => tableFor(k, l)).join("");

    const html = `
      <!doctype html>
      <html lang="he" dir="rtl">
        <head>
          <meta charset="UTF-8" />
          <title>תפריט שבועי</title>
          <style>
            @page { size: A4 landscape; margin: 12mm; }
            body { font-family: Arial, sans-serif; padding: 8px; color: #111; }
            h1 { text-align: center; font-size: 22px; margin: 0 0 4px; }
            .sub { text-align: center; font-size: 12px; color: #666; margin-bottom: 18px; }
            h2 { font-size: 16px; margin: 18px 0 6px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 10px; page-break-inside: avoid; }
            th, td { border: 1px solid #444; padding: 8px 6px; text-align: center; font-size: 14px; }
            thead th { background: #2E86C4; color: #fff; font-size: 15px; }
            .date { font-size: 10px; font-weight: normal; opacity: 0.85; }
            .corner { background: #2E86C4; }
            .rowhead { background: #D6E7F5; text-align: right; font-weight: bold; width: 110px; }
            tbody tr:nth-child(even) td { background: #F5F9FD; }
          </style>
        </head>
        <body>
          <h1>${parshaTitle ? `תפריט ${parshaTitle}` : "תפריט שבועי"}</h1>
          <div class="sub">${weekLabel(targetWeekStart)}</div>
          ${tables || '<p style="text-align:center">לא שובצו מנות לשבוע הזה</p>'}
          <script>window.onload = () => window.print();</script>
        </body>
      </html>
    `;
    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
  }


  return (
    <div>
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        <button
          onClick={() => setOrderMode("stock")}
          className="px-3 py-2 rounded-2xl text-sm font-bold whitespace-nowrap"
          style={{ background: orderMode === "stock" ? C.ink : C.kraft, color: orderMode === "stock" ? C.paper : C.ink }}
        >
          לפי סף מלאי
        </button>
        <button
          onClick={() => setOrderMode("menu")}
          className="px-3 py-2 rounded-2xl text-sm font-bold whitespace-nowrap"
          style={{ background: orderMode === "menu" ? C.ink : C.kraft, color: orderMode === "menu" ? C.paper : C.ink }}
        >
          לפי מנות בודדות
        </button>
        <button
          onClick={() => setOrderMode("week")}
          className="px-3 py-2 rounded-2xl text-sm font-bold whitespace-nowrap"
          style={{ background: orderMode === "week" ? C.ink : C.kraft, color: orderMode === "week" ? C.paper : C.ink }}
        >
          לפי תפריט שבועי
        </button>
      </div>

      {!mayApprove && (
        <ShelfTag accent={C.accent} style={{ marginBottom: 16 }}>
          <div className="text-sm font-bold mb-1" style={{ color: C.ink }}>📤 מצב בקשות הזמנה</div>
          <p className="text-xs" style={{ color: C.steel }}>
            הרכב את ההזמנה ושלח אותה לאישור המנהל. הוא יאשר וישלח לספק.
          </p>
          {myPending.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {myPending.map((r) => (
                <div key={r.id} className="text-xs p-2 rounded-xl" style={{ background: C.paper, color: C.ink }}>
                  ⏳ ממתינה לאישור · {r.items.length} מוצרים · {r.source} ·{" "}
                  {new Date(r.createdAt).toLocaleDateString("he-IL")}
                </div>
              ))}
            </div>
          )}
        </ShelfTag>
      )}

      <div className="mb-4">
        <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>
          {mayApprove ? "שלח הזמנה לספק" : "ספק מוצע (המנהל יוכל לשנות)"}
        </label>
        <select
          value={selectedSupplierId}
          onChange={(e) => setSelectedSupplierId(e.target.value)}
          className="p-2 rounded-2xl border w-full mb-3"
          style={{ borderColor: C.kraftDark }}
        >
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
          <option value="__manual__">יעד אחר (הזנה ידנית)</option>
        </select>

        {mayApprove && <ChannelPicker value={channel} onChange={setChannel} />}

        {mayApprove && (selectedSupplierId === "__manual__" || suppliers.length === 0) && (
          channel === "email" ? (
            <input
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              type="email"
              placeholder="supplier@example.com"
              className="mt-2 p-2 rounded-2xl border w-full"
              style={{ borderColor: C.kraftDark, direction: "ltr" }}
            />
          ) : (
            <input
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              placeholder="972501234567"
              className="mt-2 p-2 rounded-2xl border w-full"
              style={{ borderColor: C.kraftDark, direction: "ltr" }}
            />
          )
        )}

        {mayApprove && selectedSupplierId !== "__manual__" && suppliers.length > 0 && (() => {
          const s = suppliers.find((x) => x.id === selectedSupplierId);
          if (!s) return null;
          const missing = channel === "email" ? !s.email : !s.phone;
          if (!missing) return null;
          return (
            <p className="text-xs mt-2" style={{ color: C.stamp }}>
              {channel === "email"
                ? `לספק "${s.name}" לא שמור מייל - הוסף אותו במסך ניהול ← ספקים.`
                : `לספק "${s.name}" לא שמור טלפון - הוסף אותו במסך ניהול ← ספקים.`}
            </p>
          );
        })()}
      </div>

      {orderMode === "stock" && (() => {
        const baseList = orderSupplierFilter === "all"
          ? lowStock
          : products.filter((p) => (p.supplierId || "__unassigned__") === orderSupplierFilter);
        const filteredLowStock = orderSearch
          ? baseList.filter((p) => p.name.includes(orderSearch))
          : baseList;
        const supplierOptionsInList = Array.from(new Set(products.map((p) => p.supplierId || "__unassigned__")));

        return lowStock.length === 0 && orderSupplierFilter === "all" && !orderSearch ? (
          <ShelfTag accent={C.sage}>
            <p style={{ color: C.sage }} className="font-bold text-center">כל המלאי תקין ✓</p>
          </ShelfTag>
        ) : (
          <>
            <div className="flex gap-2 mb-3">
              <input
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                placeholder="חיפוש מוצר..."
                className="flex-1 p-2 rounded-2xl border"
                style={{ borderColor: C.kraftDark }}
              />
              <select
                value={orderSupplierFilter}
                onChange={(e) => setOrderSupplierFilter(e.target.value)}
                className="flex-1 p-2 rounded-2xl border text-sm"
                style={{ borderColor: C.kraftDark }}
              >
                <option value="all">מתחת לסף בלבד</option>
                {supplierOptionsInList.map((sid) => (
                  <option key={sid} value={sid}>
                    {sid === "__unassigned__" ? "ללא ספק משויך" : suppliers.find((s) => s.id === sid)?.name || "ספק"}
                  </option>
                ))}
              </select>
            </div>
            {orderSupplierFilter !== "all" && (
              <p className="text-xs mb-2" style={{ color: C.steel }}>
                מוצג כאן כל המלאי של הספק הזה (גם מה שיש ממנו מספיק) - סמן ✔ והקלד כמות רק למה שבאמת רוצה להזמין.
              </p>
            )}

            {filteredLowStock.length === 0 ? (
              <p className="text-sm text-center py-6" style={{ color: C.steel }}>אין מוצרים תואמים לחיפוש/סינון</p>
            ) : (
              <>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => setSelectedForOrder((cur) => Array.from(new Set([...cur, ...filteredLowStock.map((p) => p.id)])))}
                    className="text-xs font-bold px-3 py-1 rounded-full"
                    style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
                  >
                    סמן הכל
                  </button>
                  <button
                    onClick={() => setSelectedForOrder((cur) => cur.filter((id) => !filteredLowStock.some((p) => p.id === id)))}
                    className="text-xs font-bold px-3 py-1 rounded-full"
                    style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
                  >
                    בטל סימון
                  </button>
                  <span className="text-xs self-center" style={{ color: C.steel }}>
                    {selectedForOrder.length} מסומנים
                  </span>
                </div>
                <div className="flex flex-col gap-3 mb-4">
                  {filteredLowStock.map((p) => {
                    const isLow = Number(p.quantity) <= Number(p.threshold);
                    const defaultQty = isLow ? Math.max(1, Number(p.threshold) * 2 - Number(p.quantity)) : 0;
                    const checked = selectedForOrder.includes(p.id);
                    return (
                      <ShelfTag key={p.id} accent={isLow ? C.stamp : C.sage}>
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelectedForOrder((cur) =>
                                  cur.includes(p.id) ? cur.filter((id) => id !== p.id) : [...cur, p.id]
                                )
                              }
                            />
                            <div>
                              <div className="wh-display font-bold" style={{ color: C.ink }}>{p.name}</div>
                              <div className="text-xs" style={{ color: C.steel }}>יש במלאי: {p.quantity} {p.unit} (סף: {p.threshold})</div>
                            </div>
                          </div>
                          <input
                            type="number"
                            value={(qtys[p.id] ?? defaultQty) === 0 ? "" : (qtys[p.id] ?? defaultQty)}
                            onChange={(e) => setQtys((q) => ({ ...q, [p.id]: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) }))}
                            className="w-16 text-center p-2 rounded-2xl border"
                            style={{ borderColor: C.kraftDark }}
                          />
                        </div>
                      </ShelfTag>
                    );
                  })}
                </div>
              </>
            )}
            {mayApprove ? (
              <button
                onClick={sendOrder}
                className="w-full py-3 rounded-2xl wh-display font-bold"
                style={{ background: mayApprove ? channelMeta(channel).color : C.accent, color: "#fff" }}
              >
                {mayApprove
                  ? `${channelMeta(channel).icon} שלח הזמנה ב${channelMeta(channel).label}`
                  : "📤 שלח בקשה לאישור מנהל"}
              </button>
            ) : (
              <button
                onClick={() => {
                  const items = products
                    .filter((p) => selectedForOrder.includes(p.id))
                    .map((p) => ({ product: p, qty: qtys[p.id] ?? 1 }));
                  submitOrderRequest(items, selectedSupplierId, "לפי סף מלאי");
                }}
                className="w-full py-3 rounded-2xl wh-display font-bold"
                style={{ background: C.accent, color: "#fff" }}
              >
                📤 שלח בקשת הזמנה לאישור המנהל
              </button>
            )}
          </>
        );
      })()}

      {orderMode === "menu" && (
        menuItems.length === 0 ? (
          <ShelfTag accent={C.steel}>
            <p className="text-sm text-center" style={{ color: C.steel }}>
              אין עדיין מנות בתפריט. הוסף מנות במסך ניהול ← תפריט.
            </p>
          </ShelfTag>
        ) : (
          <>
            <div className="mb-3">
              <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>כמה מנות מוגשות</label>
              <input
                type="number"
                value={portions}
                onChange={(e) => setPortions(Math.max(1, Number(e.target.value)))}
                className="w-24 p-2 rounded-2xl border text-center"
                style={{ borderColor: C.kraftDark }}
              />
            </div>
            <div className="flex flex-col gap-2 mb-4">
              {menuItems.map((m) => {
                const active = selectedMenuIds.includes(m.id);
                const col = categoryColor(m.category);
                return (
                  <button
                    key={m.id}
                    onClick={() => toggleMenuItem(m.id)}
                    className="text-right p-3 rounded-2xl"
                    style={{ background: active ? col : "#fff", color: active ? "#fff" : C.ink, border: `1.5px solid ${col}` }}
                  >
                    <div className="font-bold">{m.name}</div>
                    <div className="text-xs opacity-80">{m.category}</div>
                  </button>
                );
              })}
            </div>

            {selectedMenuIds.length > 0 && (
              <>
                <div className="flex justify-between items-center mb-2">
                  <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>מה חסר לפי החישוב</div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setPickedIds(menuNeeds.map((n) => n.product.id))}
                      className="text-xs font-bold px-2 py-1 rounded-full"
                      style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
                    >
                      סמן הכל
                    </button>
                    <button
                      onClick={() => setPickedIds([])}
                      className="text-xs font-bold px-2 py-1 rounded-full"
                      style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
                    >
                      נקה
                    </button>
                  </div>
                </div>
                <p className="text-xs mb-2" style={{ color: C.steel }}>
                  סמן ✔ מה נכנס להזמנה. {pickedIds.filter((id) => menuNeeds.some((n) => n.product.id === id)).length} מסומנים.
                </p>
                <div className="flex flex-col gap-2 mb-4">
                  {menuNeeds.map((n) => {
                    const supplierName = n.product.supplierId
                      ? suppliers.find((s) => s.id === n.product.supplierId)?.name
                      : null;
                    const picked = pickedIds.includes(n.product.id);
                    return (
                      <ShelfTag key={n.product.id} accent={picked ? (n.deficit > 0 ? C.stamp : C.sage) : C.kraftDark}>
                        <div className="flex justify-between items-center text-sm">
                          <div className="flex items-center gap-2">
                            <input type="checkbox" checked={picked} onChange={() => togglePicked(n.product.id)} />
                            <div>
                              <div style={{ color: C.ink }} className="font-bold">{n.product.name}</div>
                              <div style={{ color: C.steel }} className="text-xs">
                                צריך {n.totalNeeded} · יש {n.product.quantity}
                                {supplierName && ` · ספק: ${supplierName}`}
                              </div>
                            </div>
                          </div>
                          <input
                            type="number"
                            value={getQty(menuQtys, n.product, n.deficit) === 0 ? "" : getQty(menuQtys, n.product, n.deficit)}
                            onChange={(e) =>
                              setMenuQtys((q) => ({ ...q, [n.product.id]: e.target.value === "" ? 0 : Number(e.target.value) }))
                            }
                            className="w-16 text-center p-2 rounded-2xl border"
                            style={{ borderColor: C.kraftDark }}
                          />
                        </div>
                      </ShelfTag>
                    );
                  })}
                </div>

                <ExtrasPanel />

                {Object.entries(groupRowsBySupplier(buildOrderRows(menuNeeds, menuQtys))).map(([supplierId, items]) => {
                  const supplierName = supplierId === "__unassigned__" ? "ספק כללי" : suppliers.find((s) => s.id === supplierId)?.name || "ספק";
                  return (
                    <button
                      key={supplierId}
                      onClick={() =>
                        mayApprove
                          ? sendGroupOrder(items, "📋 הזמנה לפי תפריט", supplierId)
                          : setPendingOrder({ items, title: "לפי מנות בודדות", supplierId, isRequest: true, sourceLabel: "לפי מנות בודדות" })
                      }
                      className="w-full py-3 mb-2 rounded-2xl wh-display font-bold"
                      style={{ background: mayApprove ? channelMeta(channel).color : C.accent, color: "#fff" }}
                    >
                      {mayApprove
                        ? `${channelMeta(channel).icon} שלח ל${supplierName} (${items.length} מוצרים)`
                        : `📤 בקש אישור ל${supplierName} (${items.length} מוצרים)`}
                    </button>
                  );
                })}
              </>
            )}
          </>
        )
      )}

      {orderMode === "week" && (
        menuItems.length === 0 ? (
          <ShelfTag accent={C.steel}>
            <p className="text-sm text-center" style={{ color: C.steel }}>
              קודם הוסף מנות במסך ניהול ← תפריט, ואז תוכל לשבץ אותן כאן ללוח השבועי.
            </p>
          </ShelfTag>
        ) : (
          <>
            <HebrewCalendarWidget />
            <div className="mb-3">
              <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מספר מנות/סועדים (לכל ארוחה משובצת)</label>
              <input
                type="number"
                value={weekPortions}
                onChange={(e) => setWeekPortions(Math.max(1, Number(e.target.value)))}
                className="w-24 p-2 rounded-2xl border text-center mb-2"
                style={{ borderColor: C.kraftDark }}
              />
              <div className="p-3 rounded-2xl mb-2" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
                <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>
                  התפריט הוא עבור
                </label>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => setMenuWeek("next")}
                    className="flex-1 py-1.5 rounded-xl text-xs font-bold"
                    style={{ background: menuWeek === "next" ? C.ink : C.paper, color: menuWeek === "next" ? "#fff" : C.ink, border: `1px solid ${C.kraftDark}` }}
                  >
                    שבוע הבא
                  </button>
                  <button
                    onClick={() => setMenuWeek("this")}
                    className="flex-1 py-1.5 rounded-xl text-xs font-bold"
                    style={{ background: menuWeek === "this" ? C.ink : C.paper, color: menuWeek === "this" ? "#fff" : C.ink, border: `1px solid ${C.kraftDark}` }}
                  >
                    השבוע הזה
                  </button>
                </div>

                <div className="text-center py-2 mb-2 rounded-xl" style={{ background: C.paper }}>
                  <div className="text-xs" style={{ color: C.steel }}>כותרת ההדפסה:</div>
                  <div className="wh-display font-black text-base" style={{ color: C.ink }}>
                    {parshaTitle ? `תפריט ${parshaTitle}` : "תפריט שבועי"}
                  </div>
                  <div className="text-xs" style={{ color: C.steel }}>{weekLabel(targetWeekStart)}</div>
                </div>

                <input
                  value={parshaOverride}
                  onChange={(e) => setParshaOverride(e.target.value)}
                  placeholder={autoParsha ? `לדריסה ידנית (כרגע: ${autoParsha})` : "שם הפרשה (לא נטען אוטומטית)"}
                  className="w-full p-2 rounded-xl border text-sm"
                  style={{ borderColor: C.kraftDark }}
                />
                <p className="text-xs mt-1" style={{ color: C.steel }}>
                  {autoParsha
                    ? "הפרשה נטענת אוטומטית. השדה הזה רק אם רוצים לשנות (למשל שבת חול המועד)."
                    : "לא הצלחתי לטעון את הפרשה - הזן ידנית."}
                </p>
              </div>

              <button
                onClick={printWeeklyMenu}
                className="w-full py-3 rounded-2xl text-sm font-bold"
                style={{ background: C.accent, color: "#fff" }}
              >
                🖨️ הדפס תפריט שבועי
              </button>
            </div>

            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setWeekView("grid")}
                className="flex-1 py-2 rounded-2xl text-sm font-bold"
                style={{ background: weekView === "grid" ? C.ink : C.kraft, color: weekView === "grid" ? C.paper : C.ink }}
              >
                📊 טבלה
              </button>
              <button
                onClick={() => setWeekView("days")}
                className="flex-1 py-2 rounded-2xl text-sm font-bold"
                style={{ background: weekView === "days" ? C.ink : C.kraft, color: weekView === "days" ? C.paper : C.ink }}
              >
                📅 יום-יום
              </button>
            </div>

            {weekView === "grid" && (
              <>
                <p className="text-xs mb-3" style={{ color: C.steel }}>
                  לחץ על תא כדי לבחור מנה. אפשר להחליק לצדדים כדי לראות את כל הימים.
                </p>
                {MEAL_SLOTS.map(([slotKey, slotLabel]) => (
                  <WeeklyMenuGrid
                    key={slotKey}
                    weeklyMenu={weeklyMenu}
                    setWeekSlot={setWeekSlot}
                    menuItems={menuItems}
                    dishTypes={dishTypes}
                    slotKey={slotKey}
                    slotLabel={slotLabel}
                  />
                ))}
              </>
            )}

            {weekView === "days" && (
            <div className="flex flex-col gap-2 mb-4">
              {WEEK_DAYS.map(([dayKey, dayLabel], dayIdx) => {
                const dateObj = dateForWeekdayIndex(dayIdx);
                const holiday = holidayForDate(dateObj);
                const dateStr = dateObj.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
                return (
                <ShelfTag key={dayKey} accent={holiday ? C.stamp : C.accent}>
                  <div className="flex justify-between items-center mb-2">
                    <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>{dayLabel} · {dateStr}</div>
                    {holiday && (
                      <span className="text-xs font-bold px-2 py-1 rounded-full" style={{ background: C.stamp, color: "#fff" }}>
                        🕎 {holiday.title}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    {MEAL_SLOTS.map(([slotKey, slotLabel]) => {
                      const slotSelections = weeklyMenu[dayKey]?.[slotKey] || {};
                      const chosenNames = (dishTypes || []).map((dt) => {
                        const id = slotSelections[dt.id];
                        return id ? menuItems.find((m) => m.id === id)?.name : null;
                      }).filter(Boolean);
                      return (
                        <button
                          key={slotKey}
                          onClick={() => setOpenPicker({ dayKey, dayLabel, slotKey, slotLabel })}
                          className="text-right p-3 rounded-2xl"
                          style={{ background: "#fff", border: `1.5px solid ${C.kraftDark}` }}
                        >
                          <div className="text-xs font-bold mb-1" style={{ color: C.accent }}>{slotLabel}</div>
                          <div className="text-sm" style={{ color: C.ink }}>
                            {chosenNames.length > 0 ? chosenNames.join(" · ") : "לחץ לבחירת מנות"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ShelfTag>
                );
              })}
            </div>
            )}

            {openPicker && (
              <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(35,31,61,0.5)" }} onClick={() => setOpenPicker(null)}>
                <div
                  className="w-full wh-body"
                  style={{ background: C.paper, borderRadius: "24px 24px 0 0", maxHeight: "85vh", overflowY: "auto", padding: 16 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex justify-between items-center mb-3">
                    <div className="wh-display font-bold" style={{ color: C.ink }}>
                      {openPicker.dayLabel} · {openPicker.slotLabel}
                    </div>
                    <button onClick={() => setOpenPicker(null)} className="px-3 py-1 rounded-full text-sm font-bold" style={{ background: C.ink, color: "#fff" }}>
                      סיימתי
                    </button>
                  </div>
                  {(dishTypes || []).length === 0 && (
                    <p className="text-sm text-center py-4" style={{ color: C.steel }}>
                      אין עדיין קטגוריות מוגדרות - הוסף במסך ניהול ← סוגי מנות.
                    </p>
                  )}
                  {(dishTypes || []).map((dt) => {
                    const options = menuItems.filter((m) => m.dishType === dt.id);
                    const currentId = weeklyMenu[openPicker.dayKey]?.[openPicker.slotKey]?.[dt.id] || "";
                    return (
                      <div key={dt.id} className="mb-4">
                        <div className="text-sm font-bold mb-2" style={{ color: C.accent }}>{dt.name}</div>
                        {options.length === 0 ? (
                          <p className="text-xs" style={{ color: C.steel }}>אין עדיין מנות מהסוג הזה - הוסף במסך ניהול ← תפריט</p>
                        ) : (
                          <div className="flex flex-col gap-2">
                            <button
                              onClick={() => setWeekSlot(openPicker.dayKey, openPicker.slotKey, dt.id, "")}
                              className="text-right p-2 rounded-2xl text-sm"
                              style={{
                                background: currentId === "" ? C.ink : "#fff",
                                color: currentId === "" ? "#fff" : C.steel,
                                border: `1px solid ${C.kraftDark}`,
                              }}
                            >
                              — ללא —
                            </button>
                            {options.map((m) => (
                              <button
                                key={m.id}
                                onClick={() => setWeekSlot(openPicker.dayKey, openPicker.slotKey, dt.id, m.id)}
                                className="text-right p-2 rounded-2xl text-sm font-bold"
                                style={{
                                  background: currentId === m.id ? categoryColor(m.category) : "#fff",
                                  color: currentId === m.id ? "#fff" : C.ink,
                                  border: `1.5px solid ${categoryColor(m.category)}`,
                                }}
                              >
                                {m.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {weekNeeds.chosenDishNames.length > 0 && (
              <>
                <div className="flex justify-between items-center mb-2">
                  <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>מה חסר לכל השבוע</div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setPickedIds(weekNeeds.rows.map((n) => n.product.id))}
                      className="text-xs font-bold px-2 py-1 rounded-full"
                      style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
                    >
                      סמן הכל
                    </button>
                    <button
                      onClick={() => setPickedIds([])}
                      className="text-xs font-bold px-2 py-1 rounded-full"
                      style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
                    >
                      נקה
                    </button>
                  </div>
                </div>
                <p className="text-xs mb-2" style={{ color: C.steel }}>
                  סמן ✔ מה נכנס להזמנה. {pickedIds.filter((id) => weekNeeds.rows.some((n) => n.product.id === id)).length} מסומנים.
                </p>
                <div className="flex flex-col gap-2 mb-4">
                  {weekNeeds.rows.map((n) => {
                    const supplierName = n.product.supplierId
                      ? suppliers.find((s) => s.id === n.product.supplierId)?.name
                      : null;
                    const picked = pickedIds.includes(n.product.id);
                    return (
                      <ShelfTag key={n.product.id} accent={picked ? (n.deficit > 0 ? C.stamp : C.sage) : C.kraftDark}>
                        <div className="flex justify-between items-center text-sm">
                          <div className="flex items-center gap-2">
                            <input type="checkbox" checked={picked} onChange={() => togglePicked(n.product.id)} />
                            <div>
                              <div style={{ color: C.ink }} className="font-bold">{n.product.name}</div>
                              <div style={{ color: C.steel }} className="text-xs">
                                צריך {n.totalNeeded} · יש {n.product.quantity}
                                {supplierName && ` · ספק: ${supplierName}`}
                              </div>
                            </div>
                          </div>
                          <input
                            type="number"
                            value={getQty(weekQtys, n.product, n.deficit) === 0 ? "" : getQty(weekQtys, n.product, n.deficit)}
                            onChange={(e) =>
                              setWeekQtys((q) => ({ ...q, [n.product.id]: e.target.value === "" ? 0 : Number(e.target.value) }))
                            }
                            className="w-16 text-center p-2 rounded-2xl border"
                            style={{ borderColor: C.kraftDark }}
                          />
                        </div>
                      </ShelfTag>
                    );
                  })}
                </div>

                <ExtrasPanel />

                {Object.entries(groupRowsBySupplier(buildOrderRows(weekNeeds.rows, weekQtys))).map(([supplierId, items]) => {
                  const supplierName = supplierId === "__unassigned__" ? "ספק כללי" : suppliers.find((s) => s.id === supplierId)?.name || "ספק";
                  return (
                    <button
                      key={supplierId}
                      onClick={() =>
                        mayApprove
                          ? sendGroupOrder(items, "📅 הזמנה לפי תפריט שבועי", supplierId)
                          : setPendingOrder({ items, title: "לפי תפריט שבועי", supplierId, isRequest: true, sourceLabel: "לפי תפריט שבועי" })
                      }
                      className="w-full py-3 mb-2 rounded-2xl wh-display font-bold"
                      style={{ background: mayApprove ? channelMeta(channel).color : C.accent, color: "#fff" }}
                    >
                      {mayApprove
                        ? `${channelMeta(channel).icon} שלח ל${supplierName} (${items.length} מוצרים)`
                        : `📤 בקש אישור ל${supplierName} (${items.length} מוצרים)`}
                    </button>
                  );
                })}
              </>
            )}
          </>
        )
      )}

      <OrderSummarySheet />
    </div>
  );
}

/* ---------- Tasks Tab ---------- */
/* ---------- Task detail: comment thread + follow-up reminder ---------- */
const FOLLOWUP_PRESETS = [
  ["מחר", 1],
  ["עוד יומיים", 2],
  ["עוד 3 ימים", 3],
  ["עוד שבוע", 7],
];

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(9, 0, 0, 0); // 09:00 - a sane hour to be nudged
  return d.getTime();
}
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString("he-IL", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtRelative(ts) {
  const days = Math.round((ts - Date.now()) / 86400000);
  if (days < 0) return `באיחור ${Math.abs(days)} ימים`;
  if (days === 0) return "היום";
  if (days === 1) return "מחר";
  return `בעוד ${days} ימים`;
}

function TaskDetail({ task, users, currentUser, onSave, onClose, catById }) {
  const [comment, setComment] = useState("");
  const [customDate, setCustomDate] = useState("");

  const comments = task.comments || [];
  const assignee = users.find((u) => u.id === task.assignedToId);
  const cat = catById(task.categoryId);

  async function addComment() {
    const text = comment.trim();
    if (!text) return;
    const entry = {
      id: genId(),
      userId: currentUser.id,
      userName: currentUser.name,
      text,
      createdAt: Date.now(),
    };
    await onSave({ ...task, comments: [...comments, entry] });
    setComment("");
  }

  async function setFollowUp(ts) {
    await onSave({
      ...task,
      followUpAt: ts,
      // A new date means it should fire again, even if a previous one already did.
      followUpFiredAt: null,
    });
  }

  async function clearFollowUp() {
    await onSave({ ...task, followUpAt: null, followUpFiredAt: null });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(35,31,61,0.5)" }} onClick={onClose}>
      <div
        className="w-full wh-body"
        style={{ background: C.paper, borderRadius: "24px 24px 0 0", maxHeight: "90vh", overflowY: "auto", padding: 16 }}
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="flex justify-between items-start mb-3">
          <div className="flex-1">
            <div className="wh-display font-black text-lg" style={{ color: C.ink }}>{task.title}</div>
            <div className="text-xs mt-1" style={{ color: C.steel }}>
              {cat && `${cat.icon || "📋"} ${cat.name} · `}
              {assignee?.name || "לא משויך"}
              {task.location && ` · 📍 ${task.location}`}
            </div>
          </div>
          <button onClick={onClose} className="px-3 py-1 rounded-full text-sm font-bold" style={{ background: C.ink, color: "#fff" }}>
            סגור
          </button>
        </div>

        {task.description && (
          <p className="text-sm mb-4 p-3 rounded-2xl" style={{ background: "#fff", color: C.steel }}>
            {task.description}
          </p>
        )}

        {/* ---- Follow-up reminder ---- */}
        <ShelfTag accent={task.followUpAt ? C.mustard : C.kraftDark} style={{ marginBottom: 16 }}>
          <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>⏰ תזכורת המשך</div>

          {task.followUpAt ? (
            <>
              <div className="text-sm mb-2" style={{ color: C.ink }}>
                נקבעה ל-<b>{fmtDateTime(task.followUpAt)}</b>{" "}
                <span style={{ color: task.followUpAt < Date.now() ? C.stamp : C.steel }}>
                  ({fmtRelative(task.followUpAt)})
                </span>
              </div>
              {task.followUpFiredAt && (
                <div className="text-xs mb-2" style={{ color: C.sage }}>✓ ההתראה כבר נשלחה</div>
              )}
              <button onClick={clearFollowUp} className="w-full py-2 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink }}>
                בטל תזכורת
              </button>
            </>
          ) : (
            <>
              <p className="text-xs mb-2" style={{ color: C.steel }}>
                תקבל התראה בתאריך שתבחר, כדי לבדוק מה קרה עם המשימה.
              </p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {FOLLOWUP_PRESETS.map(([label, days]) => (
                  <button
                    key={label}
                    onClick={() => setFollowUp(daysFromNow(days))}
                    className="px-3 py-1.5 rounded-full text-xs font-bold"
                    style={{ background: "#fff", color: C.mustard, border: `1.5px solid ${C.mustard}` }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="flex-1 p-2 rounded-2xl border text-sm"
                  style={{ borderColor: C.kraftDark }}
                />
                <button
                  onClick={() => {
                    if (!customDate) return;
                    const d = new Date(customDate);
                    d.setHours(9, 0, 0, 0);
                    setFollowUp(d.getTime());
                  }}
                  className="px-4 rounded-2xl font-bold text-sm"
                  style={{ background: C.mustard, color: C.ink }}
                >
                  קבע
                </button>
              </div>
            </>
          )}
        </ShelfTag>

        {/* ---- Comment thread ---- */}
        <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>
          💬 הערות והמשך טיפול {comments.length > 0 && `(${comments.length})`}
        </div>

        <div className="flex flex-col gap-2 mb-3">
          {comments.length === 0 && (
            <p className="text-xs text-center py-4" style={{ color: C.steel }}>
              אין עדיין הערות. כתוב כאן מה קרה, מה נעשה, ומה נשאר.
            </p>
          )}
          {comments.map((c) => {
            const mine = c.userId === currentUser.id;
            return (
              <div
                key={c.id}
                className="p-3 rounded-2xl"
                style={{
                  background: mine ? "#EFEAFF" : "#fff",
                  border: `1px solid ${C.kraftDark}`,
                }}
              >
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-xs font-bold" style={{ color: C.ink }}>{c.userName}</span>
                  <span className="text-xs" style={{ color: C.steel }}>{fmtDateTime(c.createdAt)}</span>
                </div>
                <div className="text-sm" style={{ color: C.ink, whiteSpace: "pre-wrap" }}>{c.text}</div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="מה קרה? מה נעשה? מה נשאר לעשות?"
            rows={2}
            className="flex-1 p-3 rounded-2xl border text-sm"
            style={{ borderColor: C.kraftDark }}
          />
          <button
            onClick={addComment}
            disabled={!comment.trim()}
            className="px-4 rounded-2xl font-bold"
            style={{
              background: comment.trim() ? C.sage : C.kraft,
              color: comment.trim() ? "#fff" : C.steel,
            }}
          >
            הוסף
          </button>
        </div>
      </div>
    </div>
  );
}

function TasksTab({ tasks, persistTasks, users, currentUser, showToast, notifyUser, locations, taskCategories, focusTaskId, onFocusConsumed }) {
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState("open");
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [editingTask, setEditingTask] = useState(null);
  const [detailTask, setDetailTask] = useState(null);

  const cats = taskCategories || [];
  const catById = (id) => cats.find((c) => c.id === id);

  /* Arrived here by tapping a notification: open that task, and clear any filter
     that would have hidden it (e.g. it's already done, or in another category). */
  useEffect(() => {
    if (!focusTaskId) return;
    const t = tasks.find((x) => x.id === focusTaskId);
    if (t) {
      setFilter("all");
      setEmployeeFilter("all");
      setCategoryFilter("all");
      setDetailTask(t);
    } else {
      showToast("המשימה לא נמצאה - ייתכן שנמחקה");
    }
    if (onFocusConsumed) onFocusConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId]);

  async function saveTask(updated) {
    const next = tasks.map((t) => (t.id === updated.id ? updated : t));
    await persistTasks(next);
    setDetailTask(updated);
  }

  // Everything below operates on what this user is *allowed* to see, not on the full list.
  const permitted = visibleTasksFor(currentUser, tasks);
  const restricted = permitted.length !== tasks.length;

  const visible = permitted
    .filter((t) => (filter === "all" ? true : filter === "open" ? t.status !== "done" : t.status === "done"))
    .filter((t) => (employeeFilter === "all" ? true : t.assignedToId === employeeFilter))
    .filter((t) => (categoryFilter === "all" ? true : t.categoryId === categoryFilter))
    .sort((a, b) => b.createdAt - a.createdAt);

  async function saveEdit(updated) {
    const original = tasks.find((t) => t.id === updated.id);
    const next = tasks.map((t) => (t.id === updated.id ? { ...t, ...updated } : t));
    await persistTasks(next);
    setEditingTask(null);
    showToast("המשימה עודכנה");
    if (notifyUser && original && updated.assignedToId !== original.assignedToId) {
      notifyUser(updated.assignedToId, `שויכה אליך משימה: ${updated.title}`, { tab: "tasks", taskId: updated.id });
    }
  }

  async function updateStatus(task, status) {
    const next = tasks.map((t) =>
      t.id === task.id
        ? { ...t, status, completedAt: status === "done" ? Date.now() : t.completedAt }
        : t
    );
    await persistTasks(next);
  }

  async function reassign(task, assignedToId) {
    const next = tasks.map((t) => (t.id === task.id ? { ...t, assignedToId } : t));
    await persistTasks(next);
    if (notifyUser && assignedToId !== task.assignedToId) {
      notifyUser(assignedToId, `שויכה אליך משימה: ${task.title}`, { tab: "tasks", taskId: task.id });
    }
  }

  async function deleteTask(task) {
    const next = tasks.filter((t) => t.id !== task.id);
    await persistTasks(next);
    showToast("המשימה נמחקה");
  }

  async function addTask(newTask) {
    const created = { ...newTask, id: genId(), createdAt: Date.now(), createdBy: currentUser.name, createdById: currentUser.id, status: "open", comments: [] };
    const next = [...tasks, created];
    await persistTasks(next);
    setShowNew(false);
    showToast("המשימה נוצרה");
    if (notifyUser) notifyUser(newTask.assignedToId, `משימה חדשה: ${newTask.title}`, { tab: "tasks", taskId: created.id });
  }

  async function notifyWhatsapp(task, mode = "share") {
    const user = users.find((u) => u.id === task.assignedToId);
    if (!user || !user.phone) {
      showToast("לא הוגדר מספר טלפון לעובד זה");
      return;
    }
    const priorityLabel = { low: "נמוכה", normal: "רגילה", urgent: "דחופה" }[task.priority] || "רגילה";
    const cat = catById(task.categoryId);
    const text = `🛠️ משימה/תקלה חדשה\nכותרת: ${task.title}${cat ? `\nקטגוריה: ${cat.name}` : ""}${task.location ? `\nמקום: ${task.location}` : ""}\nפירוט: ${task.description || "—"}\nעדיפות: ${priorityLabel}`;

    // Prefer the location photo if the task itself has none.
    const loc = (locations || []).find((l) => l.id === task.locationId);
    const photo = task.imageData || loc?.imageData || null;

    const waUrl = `https://wa.me/${user.phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

    // "chat" mode: open this employee's chat directly. WhatsApp's wa.me protocol
    // has no media parameter, so this is always text-only - by design.
    if (mode === "chat") {
      window.open(waUrl, "_blank");
      return;
    }

    if (!photo) {
      showToast("למשימה הזו אין תמונה מצורפת - נשלח טקסט בלבד");
      window.open(waUrl, "_blank");
      return;
    }

    // IMPORTANT: navigator.share() must be invoked inside the user gesture.
    // dataUrlToFile is synchronous so the gesture survives.
    let file = null;
    try {
      file = dataUrlToFile(photo, "task.jpg");
    } catch (e) {
      console.error("could not build file from image data", e);
      showToast("שגיאה: לא ניתן לקרוא את התמונה השמורה");
    }

    // Don't trust navigator.canShare here: inside an installed PWA (WebAPK) it often
    // reports false for files even though the share actually works. The real test is
    // to just try it. We attempt richest-first, then progressively simpler payloads.
    if (file && navigator.share) {
      const attempts = [
        { files: [file], text, title: "משימה" },
        { files: [file], text },
        { files: [file] },
      ];
      for (const payload of attempts) {
        // Skip a payload the browser can explicitly reject up front, but never let
        // a *missing* canShare stop us.
        if (navigator.canShare && !navigator.canShare(payload)) continue;
        try {
          await navigator.share(payload);
          if (!payload.text) {
            try { await navigator.clipboard.writeText(text); } catch (_) {}
            showToast("התמונה שותפה. הטקסט הועתק - הדבק כהערה");
          }
          return; // success
        } catch (e) {
          if (e && e.name === "AbortError") return; // user closed the sheet
          console.error("share attempt failed", payload, e);
          // try the next, simpler payload
        }
      }
    }

    // Nothing worked (or no share support): download the photo + copy the text,
    // then open the chat so the image can be attached manually.
    if (!navigator.share) {
      showToast("הדפדפן לא תומך בשיתוף - התמונה תרד לצירוף ידני");
    }
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    downloadDataUrl(photo, `task-${task.id}.jpg`);
    window.open(waUrl, "_blank");
    showToast("התמונה ירדה והטקסט הועתק - צרף את התמונה בוואטסאפ ידנית");
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <h2 className="wh-display font-black text-lg" style={{ color: C.ink }}>משימות ותקלות</h2>
        <button
          onClick={() => setShowNew(true)}
          className="px-3 py-2 rounded-2xl text-sm font-bold"
          style={{ background: C.ink, color: C.paper }}
        >
          + משימה חדשה
        </button>
      </div>

      <div className="flex gap-2 mb-4 items-center flex-wrap">
        {[["open", "פתוחות"], ["done", "סגורות"], ["all", "הכל"]].map(([val, label]) => (
          <button
            key={val}
            onClick={() => setFilter(val)}
            className="px-3 py-1 rounded-2xl text-sm font-bold"
            style={{
              background: filter === val ? C.ink : C.kraft,
              color: filter === val ? C.paper : C.ink,
            }}
          >
            {label}
          </button>
        ))}
        {(isManager(currentUser) || restricted === false || (currentUser.permissions?.taskScope || "own") !== "own") && (
          <select
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
            className="px-2 py-1 rounded-2xl text-sm border"
            style={{ borderColor: C.kraftDark, background: "#fff", color: C.ink }}
          >
            <option value="all">כל העובדים</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        )}
      </div>

      {restricted && (
        <p className="text-xs mb-3 px-1" style={{ color: C.steel }}>
          {(currentUser.permissions?.taskScope || "own") === "own"
            ? "מוצגות המשימות שהוקצו לך."
            : "מוצגות המשימות שלך והקטגוריות שנפתחו לך."}
        </p>
      )}

      {cats.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2 mb-3">
          <button
            onClick={() => setCategoryFilter("all")}
            className="px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap"
            style={{
              background: categoryFilter === "all" ? C.ink : "#fff",
              color: categoryFilter === "all" ? "#fff" : C.ink,
              border: `1px solid ${C.kraftDark}`,
            }}
          >
            כל הקטגוריות
          </button>
          {cats.map((c) => {
            const col = categoryColor(c.name);
            const active = categoryFilter === c.id;
            const count = permitted.filter(
              (t) => t.categoryId === c.id && (filter === "all" ? true : filter === "open" ? t.status !== "done" : t.status === "done")
            ).length;
            return (
              <button
                key={c.id}
                onClick={() => setCategoryFilter(c.id)}
                className="px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap"
                style={{
                  background: active ? col : "#fff",
                  color: active ? "#fff" : col,
                  border: `1.5px solid ${col}`,
                }}
              >
                {c.icon || "📋"} {c.name}{count > 0 ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>
      )}

      {showNew && (
        <NewTaskForm users={users} onSubmit={addTask} onCancel={() => setShowNew(false)} locations={locations} taskCategories={cats} />
      )}

      {detailTask && (
        <TaskDetail
          task={tasks.find((t) => t.id === detailTask.id) || detailTask}
          users={users}
          currentUser={currentUser}
          catById={catById}
          onSave={saveTask}
          onClose={() => setDetailTask(null)}
        />
      )}

      {editingTask && (
        <EditTaskForm
          task={editingTask}
          users={users}
          locations={locations}
          taskCategories={cats}
          onSubmit={saveEdit}
          onCancel={() => setEditingTask(null)}
        />
      )}

      <div className="flex flex-col gap-3">
        {visible.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: C.steel }}>אין משימות להצגה</p>
        )}
        {visible.map((t) => {
          const assignee = users.find((u) => u.id === t.assignedToId);
          const accent = t.priority === "urgent" ? C.stamp : t.priority === "low" ? C.sage : C.mustard;
          return (
            <ShelfTag key={t.id} accent={accent}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="wh-display font-bold" style={{ color: C.ink }}>{t.title}</div>
                    {(() => {
                      const cat = catById(t.categoryId);
                      if (!cat) return null;
                      const col = categoryColor(cat.name);
                      return (
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-bold whitespace-nowrap"
                          style={{ background: col, color: "#fff" }}
                        >
                          {cat.icon || "📋"} {cat.name}
                        </span>
                      );
                    })()}
                  </div>
                  {t.description && <div className="text-sm mt-1" style={{ color: C.steel }}>{t.description}</div>}
                  {t.location && (
                    <div className="text-xs mt-1 font-bold" style={{ color: C.ink }}>📍 {t.location}</div>
                  )}
                  {t.imageData ? (
                    <img src={t.imageData} alt="" className="mt-2 rounded-2xl" style={{ maxHeight: 120, maxWidth: 180 }} />
                  ) : (
                    (() => {
                      const loc = (locations || []).find((l) => l.id === t.locationId);
                      return loc?.imageData ? (
                        <img src={loc.imageData} alt="" className="mt-2 rounded-2xl" style={{ maxHeight: 120, maxWidth: 180 }} />
                      ) : null;
                    })()
                  )}
                  <div className="text-xs mt-2" style={{ color: C.steel }}>
                    שויך ל: <b style={{ color: C.ink }}>{assignee?.name || "לא משויך"}</b> · נוצר ע"י {t.createdBy}
                  </div>

                  {t.followUpAt && t.status !== "done" && (
                    <div
                      className="text-xs mt-2 inline-block px-2 py-1 rounded-full font-bold"
                      style={{
                        background: t.followUpAt < Date.now() ? C.stamp : C.mustard,
                        color: t.followUpAt < Date.now() ? "#fff" : C.ink,
                      }}
                    >
                      ⏰ בדיקת המשך {fmtRelative(t.followUpAt)}
                    </div>
                  )}

                  {(t.comments || []).length > 0 && (
                    <div className="text-xs mt-2 p-2 rounded-xl" style={{ background: C.paper, color: C.steel }}>
                      <b style={{ color: C.ink }}>{t.comments[t.comments.length - 1].userName}:</b>{" "}
                      {t.comments[t.comments.length - 1].text.slice(0, 80)}
                      {t.comments[t.comments.length - 1].text.length > 80 && "..."}
                    </div>
                  )}
                </div>
                <span
                  className="text-xs px-2 py-1 rounded-2xl font-bold whitespace-nowrap"
                  style={{ background: t.status === "done" ? C.sage : C.kraftDark, color: t.status === "done" ? "#fff" : C.ink }}
                >
                  {t.status === "done" ? "סגור" : t.status === "in_progress" ? "בטיפול" : "פתוח"}
                </span>
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                {t.status !== "in_progress" && t.status !== "done" && (
                  <button onClick={() => updateStatus(t, "in_progress")} className="px-3 py-1 rounded-2xl text-sm font-bold" style={{ background: C.mustard, color: "#fff" }}>
                    התחל טיפול
                  </button>
                )}
                {t.status !== "done" && (
                  <button onClick={() => updateStatus(t, "done")} className="px-3 py-1 rounded-2xl text-sm font-bold" style={{ background: C.sage, color: "#fff" }}>
                    סמן כסגור
                  </button>
                )}
                <button
                  onClick={() => setDetailTask(t)}
                  className="px-3 py-1 rounded-2xl text-sm font-bold"
                  style={{ background: C.mustard, color: C.ink }}
                >
                  💬 פרטים
                  {(t.comments || []).length > 0 && ` (${(t.comments || []).length})`}
                </button>
                <button
                  onClick={() => setEditingTask(t)}
                  className="px-3 py-1 rounded-2xl text-sm font-bold"
                  style={{ background: C.accent, color: "#fff" }}
                >
                  ✏️ ערוך
                </button>
                {(() => {
                  const loc = (locations || []).find((l) => l.id === t.locationId);
                  const hasPhoto = !!(t.imageData || loc?.imageData);
                  return (
                    <>
                      <button
                        onClick={() => notifyWhatsapp(t, "chat")}
                        className="px-3 py-1 rounded-2xl text-sm font-bold"
                        style={{ background: "#25D366", color: "#fff" }}
                      >
                        💬 שלח לצ'אט
                      </button>
                      {hasPhoto && (
                        <button
                          onClick={() => notifyWhatsapp(t, "share")}
                          className="px-3 py-1 rounded-2xl text-sm font-bold"
                          style={{ background: C.accent, color: "#fff" }}
                        >
                          🖼️ שתף עם תמונה
                        </button>
                      )}
                    </>
                  );
                })()}
                <button
                  onClick={() => { if (window.confirm("למחוק את המשימה הזו?")) deleteTask(t); }}
                  className="px-3 py-1 rounded-2xl text-sm font-bold"
                  style={{ background: C.stamp, color: "#fff" }}
                >
                  מחק
                </button>
              </div>
            </ShelfTag>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Convert a data URL to a File *synchronously*.
 * This matters: navigator.share() only works inside a user gesture, and awaiting
 * fetch(dataUrl) first would break the gesture chain and make the share fail.
 */
function dataUrlToFile(dataUrl, filename) {
  const [header, base64] = String(dataUrl).split(",");
  const mime = (header.match(/:(.*?);/) || [])[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

function downloadDataUrl(dataUrl, filename) {
  try {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    console.error("download failed", e);
    window.open(dataUrl, "_blank");
  }
}

function resizeImageToDataUrl(file, maxDim = 900, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function EditTaskForm({ task, users, locations, taskCategories, onSubmit, onCancel }) {
  const [title, setTitle] = useState(task.title || "");
  const [description, setDescription] = useState(task.description || "");
  const [assignedToId, setAssignedToId] = useState(task.assignedToId || users[0]?.id || "");
  const [priority, setPriority] = useState(task.priority || "normal");
  const [categoryId, setCategoryId] = useState(task.categoryId || "");
  const [locationId, setLocationId] = useState(task.locationId || "");

  const locationGroups = Object.entries(
    (locations || []).reduce((acc, loc) => {
      const g = loc.group || "אחר";
      (acc[g] = acc[g] || []).push(loc);
      return acc;
    }, {})
  );

  function submit() {
    if (!title.trim()) return;
    const loc = (locations || []).find((l) => l.id === locationId);
    onSubmit({
      id: task.id,
      title: title.trim(),
      description,
      assignedToId,
      priority,
      categoryId,
      locationId,
      location: loc ? loc.name : "",
    });
  }

  const originalAssignee = users.find((u) => u.id === task.assignedToId);
  const changedAssignee = assignedToId !== task.assignedToId;

  return (
    <ShelfTag accent={C.accent} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>עריכת משימה</div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="כותרת"
        className="p-2 rounded-2xl border"
        style={{ borderColor: C.kraftDark }}
        autoFocus
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="פירוט"
        className="p-2 rounded-2xl border"
        style={{ borderColor: C.kraftDark }}
        rows={2}
      />

      <div>
        <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>קטגוריה</label>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
          <option value="">ללא קטגוריה</option>
          {(taskCategories || []).map((c) => (
            <option key={c.id} value={c.id}>{c.icon || "📋"} {c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שיוך לעובד</label>
        <select value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {changedAssignee && (
          <p className="text-xs mt-1" style={{ color: C.accent }}>
            העברה מ{originalAssignee?.name || "לא משויך"} — תישלח לו התראה על המשימה.
          </p>
        )}
      </div>

      <div>
        <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מקום</label>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
          <option value="">ללא מקום</option>
          {locationGroups.map(([g, items]) => (
            <optgroup key={g} label={g}>
              {items.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <select value={priority} onChange={(e) => setPriority(e.target.value)} className="p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
        <option value="low">עדיפות נמוכה</option>
        <option value="normal">עדיפות רגילה</option>
        <option value="urgent">עדיפות דחופה</option>
      </select>

      <div className="flex gap-2">
        <button onClick={submit} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.sage, color: "#fff" }}>
          שמור שינויים
        </button>
        <button onClick={onCancel} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>
          ביטול
        </button>
      </div>
    </ShelfTag>
  );
}

function NewTaskForm({ users, onSubmit, onCancel, locations, taskCategories }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedToId, setAssignedToId] = useState(users[0]?.id || "");
  const [priority, setPriority] = useState("normal");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [imageData, setImageData] = useState(null);
  const [imageBusy, setImageBusy] = useState(false);

  async function handleImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setImageData(dataUrl);
    } catch (err) {
      console.error(err);
    } finally {
      setImageBusy(false);
    }
  }

  const locationGroups = Object.entries(
    (locations || []).reduce((acc, loc) => {
      const g = loc.group || "אחר";
      (acc[g] = acc[g] || []).push(loc);
      return acc;
    }, {})
  );

  return (
    <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="כותרת" className="p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }} autoFocus />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="פירוט (אופציונלי)" className="p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }} rows={2} />
      <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
        <option value="">בחר מקום (אופציונלי)</option>
        {locationGroups.map(([g, items]) => (
          <optgroup key={g} label={g}>
            {items.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {locationId && (() => {
        const loc = (locations || []).find((l) => l.id === locationId);
        return loc?.imageData ? (
          <img src={loc.imageData} alt="" className="rounded-2xl" style={{ maxHeight: 100 }} />
        ) : null;
      })()}
      <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
        <option value="">בחר קטגוריה (אופציונלי)</option>
        {(taskCategories || []).map((c) => (
          <option key={c.id} value={c.id}>{c.icon || "📋"} {c.name}</option>
        ))}
      </select>
      <select value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)} className="p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      <select value={priority} onChange={(e) => setPriority(e.target.value)} className="p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
        <option value="low">עדיפות נמוכה</option>
        <option value="normal">עדיפות רגילה</option>
        <option value="urgent">עדיפות דחופה</option>
      </select>

      <div>
        <label className="inline-block px-3 py-2 rounded-full text-sm font-bold cursor-pointer" style={{ background: C.paper, border: `1.5px solid ${C.kraftDark}`, color: C.ink }}>
          {imageBusy ? "טוען תמונה..." : imageData ? "📷 החלף תמונה" : "📷 צרף תמונה"}
          <input type="file" accept="image/*" capture="environment" onChange={handleImage} className="hidden" />
        </label>
        {imageData && (
          <div className="mt-2 relative inline-block">
            <img src={imageData} alt="" className="rounded-2xl" style={{ maxHeight: 140, maxWidth: "100%" }} />
            <button
              onClick={() => setImageData(null)}
              className="absolute -top-2 -left-2 w-6 h-6 rounded-full font-bold text-xs"
              style={{ background: C.stamp, color: "#fff" }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => {
            if (!title.trim()) return;
            const loc = (locations || []).find((l) => l.id === locationId);
            const locationLabel = loc ? `${loc.group || "אחר"} · ${loc.name}` : "";
            onSubmit({ title, description, assignedToId, priority, categoryId, location: locationLabel, locationId, imageData });
          }}
          className="flex-1 py-2 rounded-2xl font-bold"
          style={{ background: C.ink, color: C.paper }}
        >
          צור משימה
        </button>
        <button onClick={onCancel} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>
          ביטול
        </button>
      </div>
    </ShelfTag>
  );
}

/* ---------- Admin Tab ---------- */
function AdminTab({ users, updateUserProfile, deleteUserProfile, currentUser, products, persistProducts, settings, persistSettings, showToast, menuItems, persistMenuItems, weeklyMenu, persistWeeklyMenu, reminders, persistReminders, stockLog, locations, persistLocations, dishTypes, persistDishTypes, taskCategories, persistTaskCategories, orderRequests, persistOrderRequests, notifyUser, unitRequests, persistUnitRequests, logStockChange, initialSection, onSectionConsumed, tasks, orderHistory }) {
  const [section, setSection] = useState(initialSection || "products");

  // A notification can deep-link straight into a specific admin screen.
  useEffect(() => {
    if (!initialSection) return;
    setSection(initialSection);
    if (onSectionConsumed) onSectionConsumed();
  }, [initialSection]);
  const [showNav, setShowNav] = useState(false);

  const pendingCount = (orderRequests || []).filter((r) => r.status === "pending").length;

  const allSections = [
    ["orderrequests", "בקשות הזמנה"],
    ["products", "מוצרים"],
    ["users", "עובדים"],
    ["menu", "תפריט"],
    ["dishtypes", "סוגי מנות"],
    ["taskcats", "קטגוריות משימות"],
    ["locations", "מקומות"],
    ["reminders", "תזכורות"],
    ["analytics", "ניתוח"],
    ["settings", "ספקים"],
  ];
  // A supervisor only sees the admin screens the manager granted them.
  const sections = allSections.filter(([id]) => canSeeAdminSection(currentUser, id));

  // If the current section became unavailable, fall back to the first allowed one.
  useEffect(() => {
    if (sections.length > 0 && !sections.some(([id]) => id === section)) {
      setSection(sections[0][0]);
    }
  }, [sections.length, section]);

  if (sections.length === 0) {
    return <p className="text-sm text-center py-8" style={{ color: C.steel }}>אין לך הרשאות למסכי ניהול.</p>;
  }

  return (
    <div>
      <button
        onClick={() => setShowNav(true)}
        className="flex items-center gap-2 mb-4 px-3 py-2 rounded-2xl font-bold text-sm"
        style={{ background: C.ink, color: C.paper }}
      >
        ☰ {sections.find(([v]) => v === section)?.[1]}
      </button>

      {showNav && (
        <>
          <div className="fixed inset-0 z-40" style={{ background: "rgba(35,31,61,0.4)" }} onClick={() => setShowNav(false)} />
          <div
            className="fixed top-0 right-0 bottom-0 z-50 flex flex-col wh-body"
            style={{ width: "72%", maxWidth: 280, background: C.paper, boxShadow: "-8px 0 24px rgba(35,31,61,0.25)", borderRadius: "24px 0 0 24px" }}
          >
            <div className="p-4" style={{ background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`, borderRadius: "24px 0 0 0" }}>
              <div className="wh-display font-black text-lg" style={{ color: "#fff" }}>ניהול</div>
            </div>
            <div className="flex flex-col p-3 gap-2 flex-1 overflow-y-auto">
              {sections.map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => { setSection(val); setShowNav(false); }}
                  className="flex items-center justify-between text-right px-4 py-3 rounded-2xl wh-display text-sm font-bold"
                  style={{ background: section === val ? C.ink : "transparent", color: section === val ? "#fff" : C.ink }}
                >
                  <span>{label}</span>
                  {val === "orderrequests" && pendingCount > 0 && (
                    <span className="rounded-full text-[10px] px-1.5 py-0.5 font-bold" style={{ background: C.stamp, color: "#fff" }}>
                      {pendingCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {section === "products" && (
        <ProductsAdmin products={products} persistProducts={persistProducts} showToast={showToast} settings={settings} persistSettings={persistSettings} />
      )}
      {section === "users" && (
        <UsersAdmin users={users} updateUserProfile={updateUserProfile} deleteUserProfile={deleteUserProfile} showToast={showToast} currentUser={currentUser} settings={settings} persistSettings={persistSettings} taskCategories={taskCategories} />
      )}
      {section === "menu" && (
        <MenuAdmin menuItems={menuItems} persistMenuItems={persistMenuItems} products={products} showToast={showToast} weeklyMenu={weeklyMenu} persistWeeklyMenu={persistWeeklyMenu} dishTypes={dishTypes} />
      )}
      {section === "dishtypes" && (
        <DishTypesAdmin dishTypes={dishTypes} persistDishTypes={persistDishTypes} showToast={showToast} />
      )}
      {section === "orderrequests" && (
        <OrderRequestsAdmin
          orderRequests={orderRequests}
          persistOrderRequests={persistOrderRequests}
          settings={settings}
          products={products}
          showToast={showToast}
          notifyUser={notifyUser}
          currentUser={currentUser}
        />
      )}
      {section === "unitrequests" && (
        <UnitRequestsAdmin
          unitRequests={unitRequests}
          persistUnitRequests={persistUnitRequests}
          products={products}
          persistProducts={persistProducts}
          logStockChange={logStockChange}
          currentUser={currentUser}
          showToast={showToast}
          notifyUser={notifyUser}
        />
      )}
      {section === "taskcats" && (
        <TaskCategoriesAdmin taskCategories={taskCategories} persistTaskCategories={persistTaskCategories} showToast={showToast} />
      )}
      {section === "locations" && (
        <LocationsAdmin locations={locations} persistLocations={persistLocations} showToast={showToast} />
      )}
      {section === "reminders" && (
        <RemindersAdmin reminders={reminders} persistReminders={persistReminders} products={products} users={users} showToast={showToast} />
      )}
      {section === "analytics" && (
        <AnalyticsAdmin products={products} stockLog={stockLog} tasks={tasks} orderHistory={orderHistory} unitRequests={unitRequests} users={users} />
      )}
      {section === "settings" && (
        <SuppliersAdmin settings={settings} persistSettings={persistSettings} showToast={showToast} />
      )}
    </div>
  );
}

function AnalyticsAdmin({ products, stockLog, tasks = [], orderHistory = [], unitRequests = [], users = [] }) {
  const [view, setView] = useState("overview"); // overview | stock | tasks | orders
  const [range, setRange] = useState(30); // days
  const [categoryFilter, setCategoryFilter] = useState("all");

  const cutoff = Date.now() - range * 24 * 60 * 60 * 1000;

  // ---- Task stats ----
  const openTasks = tasks.filter((t) => t.status !== "done");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const doneInRange = doneTasks.filter((t) => (t.completedAt || t.createdAt || 0) >= cutoff);
  const overdueFollowups = tasks.filter((t) => t.followUpAt && t.followUpAt < Date.now() && t.status !== "done");
  const perWorker = {};
  tasks.forEach((t) => {
    const u = users.find((x) => x.id === t.assignedToId);
    const name = u?.name || "לא משויך";
    if (!perWorker[name]) perWorker[name] = { open: 0, done: 0 };
    if (t.status === "done") perWorker[name].done++;
    else perWorker[name].open++;
  });

  // ---- Order stats ----
  const ordersInRange = orderHistory.filter((o) => o.createdAt >= cutoff);
  const orderTotal = ordersInRange.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const perSupplier = {};
  ordersInRange.forEach((o) => {
    const name = o.supplierName || "ספק כללי";
    if (!perSupplier[name]) perSupplier[name] = { count: 0, total: 0 };
    perSupplier[name].count++;
    perSupplier[name].total += Number(o.total || 0);
  });

  const fmtDate = (ts) => new Date(ts).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div>
      <h2 className="wh-display font-black text-lg mb-3" style={{ color: C.ink }}>סיכום ונתונים</h2>

      <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
        {[["overview", "כללי"], ["tasks", "משימות"], ["orders", "הזמנות"], ["stock", "צריכת מלאי"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className="px-4 py-2 rounded-2xl text-sm font-bold whitespace-nowrap"
            style={{ background: view === id ? C.ink : C.kraft, color: view === id ? C.paper : C.ink }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex gap-2 mb-4">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setRange(d)}
            className="flex-1 py-1.5 rounded-xl text-xs font-bold"
            style={{ background: range === d ? C.accent : "#fff", color: range === d ? "#fff" : C.ink, border: `1px solid ${C.kraftDark}` }}
          >
            {d} ימים
          </button>
        ))}
      </div>

      {view === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <StatCard label="משימות פתוחות" value={openTasks.length} color={C.mustard} />
            <StatCard label={`הושלמו (${range} ימים)`} value={doneInRange.length} color={C.sage} />
            <StatCard label={`הזמנות (${range} ימים)`} value={ordersInRange.length} color={C.accent} />
            <StatCard label={`סכום הזמנות`} value={`₪${orderTotal.toFixed(0)}`} color={C.ink} />
          </div>
          {overdueFollowups.length > 0 && (
            <ShelfTag accent={C.stamp} style={{ marginBottom: 12 }}>
              <div className="font-bold text-sm" style={{ color: C.stamp }}>
                ⏰ {overdueFollowups.length} תזכורות המשך באיחור
              </div>
              <p className="text-xs" style={{ color: C.steel }}>משימות שקבעת להן בדיקת המשך והתאריך עבר.</p>
            </ShelfTag>
          )}
          <ShelfTag accent={C.steel}>
            <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>עומס לפי עובד</div>
            {Object.entries(perWorker).length === 0 ? (
              <p className="text-xs" style={{ color: C.steel }}>אין נתונים</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {Object.entries(perWorker).sort((a, b) => b[1].open - a[1].open).map(([name, s]) => (
                  <div key={name} className="flex justify-between text-sm">
                    <span style={{ color: C.ink }}>{name}</span>
                    <span style={{ color: C.steel }}>
                      <b style={{ color: C.mustard }}>{s.open}</b> פתוחות · <b style={{ color: C.sage }}>{s.done}</b> הושלמו
                    </span>
                  </div>
                ))}
              </div>
            )}
          </ShelfTag>
        </>
      )}

      {view === "tasks" && (
        <>
          <div className="grid grid-cols-3 gap-2 mb-4">
            <StatCard label="פתוחות" value={openTasks.length} color={C.mustard} small />
            <StatCard label="הושלמו" value={doneTasks.length} color={C.sage} small />
            <StatCard label="באיחור" value={overdueFollowups.length} color={C.stamp} small />
          </div>
          <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>
            הושלמו לאחרונה
          </div>
          <div className="flex flex-col gap-2">
            {doneTasks.sort((a, b) => (b.completedAt || b.createdAt || 0) - (a.completedAt || a.createdAt || 0)).slice(0, 20).map((t) => {
              const u = users.find((x) => x.id === t.assignedToId);
              return (
                <ShelfTag key={t.id} accent={C.sage}>
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-bold text-sm" style={{ color: C.ink }}>{t.title}</div>
                      <div className="text-xs" style={{ color: C.steel }}>{u?.name || "—"}</div>
                    </div>
                    <span className="text-xs" style={{ color: C.steel }}>
                      {t.completedAt ? fmtDate(t.completedAt) : ""}
                    </span>
                  </div>
                </ShelfTag>
              );
            })}
            {doneTasks.length === 0 && <p className="text-sm text-center py-6" style={{ color: C.steel }}>עדיין לא הושלמו משימות</p>}
          </div>
        </>
      )}

      {view === "orders" && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <StatCard label={`הזמנות (${range} ימים)`} value={ordersInRange.length} color={C.accent} />
            <StatCard label="סכום כולל" value={`₪${orderTotal.toFixed(0)}`} color={C.ink} />
          </div>

          {Object.keys(perSupplier).length > 0 && (
            <ShelfTag accent={C.accent} style={{ marginBottom: 12 }}>
              <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>לפי ספק</div>
              <div className="flex flex-col gap-1.5">
                {Object.entries(perSupplier).sort((a, b) => b[1].total - a[1].total).map(([name, s]) => (
                  <div key={name} className="flex justify-between text-sm">
                    <span style={{ color: C.ink }}>{name}</span>
                    <span style={{ color: C.steel }}>{s.count} הזמנות · ₪{s.total.toFixed(0)}</span>
                  </div>
                ))}
              </div>
            </ShelfTag>
          )}

          <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>הזמנות אחרונות</div>
          <div className="flex flex-col gap-2">
            {ordersInRange.length === 0 && (
              <ShelfTag accent={C.steel}>
                <p className="text-sm text-center" style={{ color: C.steel }}>
                  לא נשלחו הזמנות בטווח הזה.
                  <br />
                  <span className="text-xs">היסטוריית הזמנות נשמרת מרגע העדכון הזה והלאה.</span>
                </p>
              </ShelfTag>
            )}
            {ordersInRange.map((o) => (
              <details key={o.id}>
                <summary className="cursor-pointer">
                  <ShelfTag accent={channelMeta(o.channel).color} style={{ display: "inline-block", width: "100%" }}>
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-bold text-sm" style={{ color: C.ink }}>
                          {channelMeta(o.channel).icon} {o.supplierName}
                        </div>
                        <div className="text-xs" style={{ color: C.steel }}>
                          {fmtDate(o.createdAt)} · {o.items?.length || 0} מוצרים
                          {o.by && ` · ${o.by}`}
                        </div>
                      </div>
                      <span className="font-bold text-sm" style={{ color: C.ink }}>₪{Number(o.total || 0).toFixed(0)}</span>
                    </div>
                  </ShelfTag>
                </summary>
                <div className="px-3 py-2 text-xs" style={{ color: C.steel }}>
                  {(o.items || []).map((it, i) => (
                    <div key={i} className="flex justify-between">
                      <span>{it.name}</span>
                      <span>{it.qty} {it.unit}</span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </>
      )}

      {view === "stock" && (
        <AnalyticsStock products={products} stockLog={stockLog} range={range} categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter} />
      )}
    </div>
  );
}

function StatCard({ label, value, color, small }) {
  return (
    <div className="rounded-2xl p-3 text-center" style={{ background: "#fff", border: `1px solid ${C.kraftDark}`, borderTop: `4px solid ${color}` }}>
      <div className="wh-display font-black" style={{ color, fontSize: small ? 22 : 28 }}>{value}</div>
      <div className="text-xs" style={{ color: C.steel }}>{label}</div>
    </div>
  );
}

function AnalyticsStock({ products, stockLog, range, categoryFilter, setCategoryFilter }) {
  const cutoff = Date.now() - range * 24 * 60 * 60 * 1000;
  const relevantLog = stockLog.filter((e) => e.timestamp >= cutoff);

  const perProduct = {};
  relevantLog.forEach((e) => {
    if (e.delta >= 0) return;
    if (!perProduct[e.productId]) perProduct[e.productId] = 0;
    perProduct[e.productId] += Math.abs(e.delta);
  });

  const rows = Object.entries(perProduct)
    .map(([pid, consumed]) => {
      const p = products.find((x) => x.id === pid);
      if (!p) return null;
      if (categoryFilter !== "all" && (p.category || "ללא קטגוריה") !== categoryFilter) return null;
      return { product: p, consumed };
    })
    .filter(Boolean)
    .sort((a, b) => b.consumed - a.consumed);

  const categories = Array.from(new Set(products.map((p) => p.category || "ללא קטגוריה")));
  const max = rows.length ? rows[0].consumed : 1;

  return (
    <>
      <select
        value={categoryFilter}
        onChange={(e) => setCategoryFilter(e.target.value)}
        className="p-2 rounded-2xl border w-full mb-3 text-sm"
        style={{ borderColor: C.kraftDark }}
      >
        <option value="all">כל הקטגוריות</option>
        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>

      <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>המוצרים הכי נצרכים</div>
      {rows.length === 0 ? (
        <p className="text-sm text-center py-6" style={{ color: C.steel }}>אין תנועת מלאי בטווח הזה</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.slice(0, 25).map(({ product, consumed }) => (
            <div key={product.id}>
              <div className="flex justify-between text-sm mb-0.5">
                <span style={{ color: C.ink }}>{product.name}</span>
                <span className="font-bold" style={{ color: C.ink }}>{consumed} {product.unit}</span>
              </div>
              <div className="rounded-full overflow-hidden" style={{ background: C.kraft, height: 8 }}>
                <div style={{ background: C.accent, height: "100%", width: `${(consumed / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function OldAnalyticsAdmin({ products, stockLog }) {
  const [range, setRange] = useState(30); // days
  const [categoryFilter, setCategoryFilter] = useState("all");

  const cutoff = Date.now() - range * 24 * 60 * 60 * 1000;
  const relevantLog = stockLog.filter((e) => e.timestamp >= cutoff);

  const perProduct = {};
  relevantLog.forEach((e) => {
    if (e.delta >= 0) return; // only count consumption (decreases)
    if (!perProduct[e.productId]) perProduct[e.productId] = 0;
    perProduct[e.productId] += Math.abs(e.delta);
  });

  let rows = Object.entries(perProduct)
    .map(([productId, consumed]) => {
      const product = products.find((p) => p.id === productId);
      if (!product) return null;
      return { product, consumed };
    })
    .filter(Boolean);

  if (categoryFilter !== "all") {
    rows = rows.filter((r) => (r.product.category || "ללא קטגוריה") === categoryFilter);
  }

  rows.sort((a, b) => b.consumed - a.consumed);
  const maxConsumed = rows.length > 0 ? rows[0].consumed : 1;
  const totalEvents = relevantLog.length;

  const categories = Array.from(new Set(products.map((p) => p.category || "ללא קטגוריה")));

  return (
    <div>
      <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setRange(d)}
            className="px-3 py-2 rounded-2xl text-sm font-bold whitespace-nowrap"
            style={{ background: range === d ? C.ink : C.kraft, color: range === d ? C.paper : C.ink }}
          >
            {d} ימים אחרונים
          </button>
        ))}
      </div>

      <div className="mb-4">
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="p-2 rounded-2xl border w-full text-sm"
          style={{ borderColor: C.kraftDark }}
        >
          <option value="all">כל הקטגוריות</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {totalEvents === 0 ? (
        <ShelfTag accent={C.steel}>
          <p className="text-sm text-center" style={{ color: C.steel }}>
            עדיין אין מספיק היסטוריית שינויי מלאי בטווח הזה. ברגע שיתבצעו עדכוני כמות במסך המלאי, הנתונים כאן יתמלאו אוטומטית.
          </p>
        </ShelfTag>
      ) : rows.length === 0 ? (
        <ShelfTag accent={C.steel}>
          <p className="text-sm text-center" style={{ color: C.steel }}>אין ירידות במלאי בקטגוריה הזו בטווח שנבחר</p>
        </ShelfTag>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map(({ product, consumed }) => {
            const pct = Math.max(6, Math.round((consumed / maxConsumed) * 100));
            const col = categoryColor(product.category || "ללא קטגוריה");
            return (
              <ShelfTag key={product.id} accent={col}>
                <div className="flex justify-between items-center mb-2 text-sm">
                  <span className="font-bold" style={{ color: C.ink }}>{product.name}</span>
                  <span style={{ color: C.steel }}>{consumed} {product.unit} · ₪{(consumed * Number(product.price)).toFixed(0)}</span>
                </div>
                <div style={{ background: C.paper, borderRadius: 8, height: 10, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, background: col, height: "100%" }} />
                </div>
              </ShelfTag>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LocationsAdmin({ locations, persistLocations, showToast }) {
  const empty = { name: "", group: "", imageData: null };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [search, setSearch] = useState("");
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);

  async function handleImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setForm((f) => ({ ...f, imageData: dataUrl }));
    } catch (err) {
      console.error(err);
    } finally {
      setImageBusy(false);
    }
  }

  function downloadTemplate() {
    const rows = [
      { "שם מקום/חדר": "חדר 101", "קבוצה/אזור": "קומה 1" },
      { "שם מקום/חדר": "מטבח בשרי", "קבוצה/אזור": "מטבחים" },
    ];
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = [{ wch: 26 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Locations");
    XLSX.writeFile(wb, "locations-template.xlsx");
  }

  function exportLocations() {
    const rows = locations.map((l) => ({ "שם מקום/חדר": l.name, "קבוצה/אזור": l.group || "" }));
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "שם מקום/חדר": "", "קבוצה/אזור": "" }]);
    sheet["!cols"] = [{ wch: 26 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Locations");
    XLSX.writeFile(wb, "locations-export.xlsx");
    showToast("הקובץ יורד עכשיו");
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const norm = (s) => String(s).trim().toLowerCase();
      function pick(row, keys) {
        for (const k of Object.keys(row)) {
          if (keys.includes(norm(k))) return row[k];
        }
        return "";
      }
      const imported = rows
        .map((row) => {
          const name = pick(row, ["name", "שם", "שם מקום", "שם מקום/חדר", "חדר"]);
          if (!name) return null;
          const group = String(pick(row, ["group", "קבוצה", "קבוצה/אזור", "אזור", "קומה"]) || "");
          return { name: String(name), group };
        })
        .filter(Boolean);

      if (imported.length === 0) {
        showToast("לא נמצאו שורות עם שם מקום תקין");
        return;
      }
      let next = [...locations];
      let added = 0, updated = 0;
      for (const item of imported) {
        const idx = next.findIndex((l) => l.name.trim().toLowerCase() === item.name.trim().toLowerCase());
        if (idx >= 0) {
          next[idx] = { ...next[idx], ...item };
          updated++;
        } else {
          next.push({ ...item, id: genId(), imageData: null });
          added++;
        }
      }
      await persistLocations(next);
      showToast(`נוספו ${added} מקומות, עודכנו ${updated}`);
    } catch (err) {
      console.error(err);
      showToast("שגיאה בקריאת הקובץ");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function save() {
    if (!form.name.trim()) return showToast("יש להזין שם מקום/חדר");
    let next;
    if (editingId) {
      next = locations.map((l) => (l.id === editingId ? { ...form, id: editingId } : l));
    } else {
      next = [...locations, { ...form, id: genId() }];
    }
    await persistLocations(next);
    setForm(empty);
    setEditingId(null);
    showToast("המקום נשמר");
  }

  async function remove(id) {
    await persistLocations(locations.filter((l) => l.id !== id));
  }

  const filtered = locations.filter((l) => !search || l.name.includes(search) || (l.group || "").includes(search));
  const grouped = Object.entries(
    filtered.reduce((acc, l) => {
      const g = l.group || "אחר";
      (acc[g] = acc[g] || []).push(l);
      return acc;
    }, {})
  );

  return (
    <div>
      <div className="mb-4">
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} className="hidden" />
        <div className="flex gap-2 mb-2">
          <button onClick={downloadTemplate} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}>
            📄 הורד תבנית ריקה
          </button>
          <button onClick={exportLocations} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.accent, color: "#fff" }}>
            📤 ייצא רשימה קיימת
          </button>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="w-full py-2 rounded-2xl font-bold text-sm"
          style={{ background: C.mustard, color: C.ink }}
        >
          {importing ? "מייבא..." : "📥 ייבוא מקומות מקובץ אקסל/CSV"}
        </button>
        <p className="text-xs mt-1 text-center" style={{ color: C.steel }}>
          עמודות: שם מקום/חדר, קבוצה/אזור. התאמה לפי שם מעדכנת מקום קיים במקום ליצור כפול.
        </p>
      </div>

      <ShelfTag accent={C.accent} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>
          {editingId ? "עריכת מקום" : "הוספת מקום/חדר"}
        </div>
        <p className="text-xs" style={{ color: C.steel }}>
          כל מוסד שונה - הרשימה הזו שלך לגמרי, אפשר להוסיף, לערוך ולמחוק חדרים/מקומות כרצונך.
        </p>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שם המקום/חדר</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} placeholder="לדוגמה: חדר 105" />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>קבוצה/אזור (לארגון ברשימה)</label>
          <input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} placeholder="לדוגמה: קומה 1" />
        </div>
        <div>
          <label className="inline-block px-3 py-2 rounded-full text-sm font-bold cursor-pointer" style={{ background: C.paper, border: `1.5px solid ${C.kraftDark}`, color: C.ink }}>
            {imageBusy ? "טוען תמונה..." : form.imageData ? "📷 החלף תמונה" : "📷 צרף תמונה של המקום"}
            <input type="file" accept="image/*" capture="environment" onChange={handleImage} className="hidden" />
          </label>
          {form.imageData && (
            <div className="mt-2 relative inline-block">
              <img src={form.imageData} alt="" className="rounded-2xl" style={{ maxHeight: 140, maxWidth: "100%" }} />
              <button onClick={() => setForm({ ...form, imageData: null })} className="absolute -top-2 -left-2 w-6 h-6 rounded-full font-bold text-xs" style={{ background: C.stamp, color: "#fff" }}>✕</button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
            {editingId ? "שמור שינויים" : "הוסף מקום"}
          </button>
          {editingId && (
            <button onClick={() => { setForm(empty); setEditingId(null); }} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>ביטול</button>
          )}
        </div>
      </ShelfTag>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="חיפוש מקום..."
        className="p-2 rounded-2xl border w-full mb-3"
        style={{ borderColor: C.kraftDark, background: "#fff" }}
      />

      <div className="flex flex-col gap-4">
        {locations.length === 0 && (
          <p className="text-sm text-center py-4" style={{ color: C.steel }}>אין עדיין מקומות - הוסף למעלה</p>
        )}
        {grouped.map(([g, items]) => (
          <div key={g}>
            <div className="wh-display font-bold text-sm mb-2" style={{ color: C.steel }}>{g} ({items.length})</div>
            <div className="flex flex-col gap-2">
              {items.map((l) => (
                <div key={l.id} className="flex justify-between items-center p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
                  <div className="flex items-center gap-2">
                    {l.imageData && <img src={l.imageData} alt="" className="rounded-xl" style={{ width: 40, height: 40, objectFit: "cover" }} />}
                    <div className="font-bold text-sm" style={{ color: C.ink }}>{l.name}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => { setForm(l); setEditingId(l.id); }} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
                    <button onClick={() => remove(l.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RemindersAdmin({ reminders, persistReminders, products, users, showToast }) {
  const empty = { title: "", productId: "", assignedToId: users[0]?.id || "", dayOfWeek: 0, active: true };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);

  async function save() {
    if (!form.title.trim() && !form.productId) return showToast("יש להזין כותרת או לבחור מוצר");
    let next;
    if (editingId) {
      next = reminders.map((r) => (r.id === editingId ? { ...form, id: editingId, lastTriggeredDate: r.lastTriggeredDate } : r));
    } else {
      next = [...reminders, { ...form, id: genId(), lastTriggeredDate: null }];
    }
    await persistReminders(next);
    setForm(empty);
    setEditingId(null);
    showToast("התזכורת נשמרה");
  }

  async function remove(id) {
    await persistReminders(reminders.filter((r) => r.id !== id));
  }

  async function toggleActive(rem) {
    await persistReminders(reminders.map((r) => (r.id === rem.id ? { ...r, active: !r.active } : r)));
  }

  return (
    <div>
      <ShelfTag accent={C.accent2} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>
          {editingId ? "עריכת תזכורת" : "תזכורת שבועית חדשה"}
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מוצר לבדיקה (אופציונלי)</label>
          <select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="">— ללא מוצר ספציפי —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>כותרת/פירוט התזכורת</label>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={form.productId ? "לדוגמה: לבדוק תוקף ולספור מלאי" : "לדוגמה: לבדוק מקפיא תחתון"}
            className="p-2 rounded-2xl border w-full"
            style={{ borderColor: C.kraftDark }}
          />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>יום בשבוע לתזכורת</label>
          <select value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: Number(e.target.value) })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            {WEEK_DAYS.map(([key, label], idx) => <option key={key} value={idx}>{label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שלח תזכורת לעובד</label>
          <select value={form.assignedToId} onChange={(e) => setForm({ ...form, assignedToId: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
            {editingId ? "שמור שינויים" : "צור תזכורת"}
          </button>
          {editingId && (
            <button onClick={() => { setForm(empty); setEditingId(null); }} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>
              ביטול
            </button>
          )}
        </div>
        <p className="text-xs" style={{ color: C.steel }}>
          התזכורת תיצור אוטומטית משימה ותשלח התראה לעובד בכל פעם שמישהו פותח את האפליקציה ביום הנבחר (או אחריו) ועוד לא נוצרה תזכורת השבוע.
        </p>
      </ShelfTag>

      <div className="flex flex-col gap-2">
        {reminders.length === 0 && (
          <p className="text-sm text-center py-4" style={{ color: C.steel }}>אין תזכורות עדיין</p>
        )}
        {reminders.map((r) => {
          const product = products.find((p) => p.id === r.productId);
          const assignee = users.find((u) => u.id === r.assignedToId);
          return (
            <div key={r.id} className="p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}`, opacity: r.active ? 1 : 0.5 }}>
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-bold text-sm" style={{ color: C.ink }}>{product ? `בדוק ${product.name}` : r.title}</div>
                  <div className="text-xs" style={{ color: C.steel }}>
                    {WEEK_DAYS[r.dayOfWeek]?.[1]} · {assignee ? assignee.name : "—"} {!r.active && "· מושהה"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => toggleActive(r)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>
                    {r.active ? "השהה" : "הפעל"}
                  </button>
                  <button onClick={() => { setForm(r); setEditingId(r.id); }} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
                  <button onClick={() => remove(r.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupLinkEditor({ settings, persistSettings, showToast }) {
  const [link, setLink] = useState(settings?.whatsappGroupLink || "");

  async function save() {
    const v = link.trim();
    if (v && !v.includes("chat.whatsapp.com") && !v.startsWith("https://")) {
      return showToast("הקישור לא נראה תקין - הוא צריך להתחיל ב-https://chat.whatsapp.com");
    }
    await persistSettings({ ...settings, whatsappGroupLink: v });
    showToast(v ? "קישור הקבוצה נשמר ✓" : "קישור הקבוצה נמחק");
  }

  return (
    <div className="flex gap-2">
      <input
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="https://chat.whatsapp.com/..."
        className="flex-1 p-2 rounded-2xl border text-sm"
        style={{ borderColor: C.kraftDark, direction: "ltr" }}
      />
      <button onClick={save} className="px-4 rounded-2xl font-bold text-sm" style={{ background: "#128C7E", color: "#fff" }}>
        שמור
      </button>
    </div>
  );
}

function SuppliersAdmin({ settings, persistSettings, showToast }) {
  const suppliers = settings.suppliers || [];
  const empty = { name: "", phone: "", email: "" };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const contactsSupported = typeof navigator !== "undefined" && "contacts" in navigator && "ContactsManager" in window;

  function normalizePhone(raw) {
    let digits = String(raw || "").replace(/\D/g, "");
    if (digits.startsWith("0")) digits = "972" + digits.slice(1);
    return digits;
  }

  async function pickContact() {
    if (!contactsSupported) {
      showToast("הדפדפן הזה לא תומך בייבוא מאנשי קשר (זמין כרגע רק ב-Chrome באנדרואיד)");
      return;
    }
    try {
      const contacts = await navigator.contacts.select(["name", "tel", "email"], { multiple: true });
      if (!contacts || contacts.length === 0) {
        showToast("לא נבחרו אנשי קשר");
        return;
      }
      const newSuppliers = contacts
        .map((c) => ({
          id: genId(),
          name: c.name?.[0] || "ללא שם",
          phone: normalizePhone(c.tel?.[0] || ""),
          email: (c.email?.[0] || "").trim(),
        }))
        .filter((s) => s.phone || s.email);

      if (newSuppliers.length === 0) {
        showToast("לאנשי הקשר שנבחרו אין טלפון או מייל שמורים");
        return;
      }

      await persistSettings({ ...settings, suppliers: [...suppliers, ...newSuppliers] });
      showToast(`נוספו ${newSuppliers.length} ספקים מאנשי הקשר`);
    } catch (err) {
      console.error(err);
      if (window.matchMedia("(display-mode: standalone)").matches) {
        showToast("ייבוא מאנשי קשר לא עובד באפליקציה המותקנת - פתח את האתר בכרום רגיל (לא מהאייקון) ונסה שוב");
      } else {
        showToast("שגיאה בייבוא אנשי קשר: " + (err?.message || "לא ידועה"));
      }
    }
  }

  async function save() {
    if (!form.name.trim()) return showToast("יש להזין שם ספק");
    if (!form.phone.trim() && !form.email.trim())
      return showToast("יש להזין לפחות טלפון או מייל");
    let next;
    if (editingId) {
      next = suppliers.map((s) => (s.id === editingId ? { ...form, id: editingId } : s));
    } else {
      next = [...suppliers, { ...form, id: genId() }];
    }
    await persistSettings({ ...settings, suppliers: next });
    setForm(empty);
    setEditingId(null);
    showToast("הספק נשמר");
  }

  async function remove(id) {
    await persistSettings({ ...settings, suppliers: suppliers.filter((s) => s.id !== id) });
  }

  return (
    <div>
      <ShelfTag accent="#128C7E" style={{ marginBottom: 16 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>👥 קבוצת וואטסאפ להזמנות</div>
        <p className="text-xs mb-2" style={{ color: C.steel }}>
          אם יש קבוצת ספקים בוואטסאפ, הדבק כאן את קישור ההזמנה שלה. אז בסיכום ההזמנה יופיע כפתור "שלח לקבוצה" שמעתיק את ההזמנה ופותח את הקבוצה.
        </p>
        <GroupLinkEditor settings={settings} persistSettings={persistSettings} showToast={showToast} />
        <details className="mt-2">
          <summary className="text-xs font-bold cursor-pointer" style={{ color: C.accent }}>איך משיגים את קישור הקבוצה?</summary>
          <p className="text-xs mt-1" style={{ color: C.steel, lineHeight: 1.6 }}>
            בוואטסאפ: פתח את הקבוצה ← שם הקבוצה למעלה ← "הזמנה באמצעות קישור" ← "העתק קישור". הדבק אותו כאן.
            הקישור נראה כך: <span style={{ direction: "ltr", display: "inline-block" }}>chat.whatsapp.com/...</span>
          </p>
        </details>
      </ShelfTag>

      <ShelfTag accent={C.accent} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>
          {editingId ? "עריכת ספק" : "הוספת ספק"}
        </div>
        <button
          onClick={pickContact}
          className="py-2 rounded-2xl font-bold text-sm"
          style={{ background: contactsSupported ? C.accent : C.kraft, color: contactsSupported ? "#fff" : C.steel, border: `1px solid ${C.kraftDark}` }}
        >
          📇 ייבוא ספקים מאנשי קשר (אפשר לבחור כמה)
        </button>
        {!contactsSupported && (
          <p className="text-xs" style={{ color: C.steel }}>
            זמין כרגע רק ב-Chrome באנדרואיד. בדפדפנים אחרים אפשר להזין ידנית למטה.
          </p>
        )}
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שם הספק</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>טלפון (לוואטסאפ / SMS)</label>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="972501234567" className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מייל (לשליחת הזמנה במייל)</label>
          <input value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" placeholder="supplier@example.com" className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
        </div>
        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
            {editingId ? "שמור שינויים" : "הוסף ספק"}
          </button>
          {editingId && (
            <button onClick={() => { setForm(empty); setEditingId(null); }} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>
              ביטול
            </button>
          )}
        </div>
      </ShelfTag>

      <div className="flex flex-col gap-2">
        {suppliers.length === 0 && (
          <p className="text-sm text-center py-4" style={{ color: C.steel }}>אין ספקים עדיין - הוסף למעלה</p>
        )}
        {suppliers.map((s) => (
          <div key={s.id} className="flex justify-between items-center p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
            <div>
              <div className="font-bold text-sm" style={{ color: C.ink }}>{s.name}</div>
              <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>
                {s.phone || "ללא טלפון"}
              </div>
              <div className="text-xs" style={{ color: s.email ? C.steel : C.kraftDark, direction: "ltr", textAlign: "right" }}>
                {s.email || "ללא מייל"}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setForm({ email: "", ...s }); setEditingId(s.id); }} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
              <button onClick={() => remove(s.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UnitRequestsAdmin({
  unitRequests,
  persistUnitRequests,
  products,
  persistProducts,
  logStockChange,
  currentUser,
  showToast,
  notifyUser,
}) {
  const [tab, setTab] = useState("pending");
  const [editing, setEditing] = useState(null); // { requestId, items, note }

  const all = [...(unitRequests || [])].sort((a, b) => (b.submittedAt || b.createdAt) - (a.submittedAt || a.createdAt));
  const pending = all.filter((r) => r.status === "submitted");
  const done = all.filter((r) => r.status === "fulfilled" || r.status === "rejected");
  const shown = tab === "pending" ? pending : done;

  const stockOf = (id) => Number(products.find((p) => p.id === id)?.quantity ?? 0);

  function openReview(r) {
    setEditing({
      requestId: r.id,
      // Default the issued amount to what they asked for, capped at what we actually have.
      items: (r.items || []).map((i) => ({ ...i, give: Math.min(i.qty, stockOf(i.productId)) })),
      note: "",
    });
  }

  function setGive(productId, val) {
    setEditing((cur) => ({
      ...cur,
      items: cur.items.map((i) => (i.productId === productId ? { ...i, give: Math.max(0, Number(val) || 0) } : i)),
    }));
  }

  /* One tap to drop a line entirely, instead of having to zero out the quantity. */
  function removeItem(productId) {
    setEditing((cur) => ({ ...cur, items: cur.items.filter((i) => i.productId !== productId) }));
  }

  function giveAll() {
    setEditing((cur) => ({
      ...cur,
      items: cur.items.map((i) => ({ ...i, give: Math.min(i.qty, stockOf(i.productId)) })),
    }));
  }

  function giveNone() {
    setEditing((cur) => ({ ...cur, items: cur.items.map((i) => ({ ...i, give: 0 })) }));
  }

  async function fulfill() {
    const req = all.find((r) => r.id === editing.requestId);
    const issued = editing.items.filter((i) => i.give > 0);
    if (issued.length === 0) return showToast("לא הוגדרה כמות לניפוק");

    // Deduct from stock and log who issued what.
    const next = products.map((p) => {
      const hit = issued.find((i) => i.productId === p.id);
      if (!hit) return p;
      return { ...p, quantity: Math.max(0, Number(p.quantity) - hit.give) };
    });
    await persistProducts(next);
    for (const i of issued) {
      if (logStockChange) await logStockChange(i.productId, -i.give, `${currentUser.name} → ${req.unitName}`);
    }

    await persistUnitRequests(
      (unitRequests || []).map((r) =>
        r.id === editing.requestId
          ? {
              ...r,
              status: "fulfilled",
              fulfilledAt: Date.now(),
              fulfilledBy: currentUser.name,
              managerNote: editing.note,
              issuedItems: issued.map((i) => ({ productId: i.productId, name: i.name, unit: i.unit, qty: i.give })),
            }
          : r
      )
    );

    const shortages = editing.items.filter((i) => i.give < i.qty);
    if (notifyUser) {
      const msg = shortages.length
        ? `🧺 הבקשה שלך נופקה חלקית (${shortages.length} מוצרים בחוסר)`
        : "🧺 הבקשה שלך נופקה במלואה ✓";
      await notifyUser(req.unitId, msg, { tab: "unitrequest" });
    }
    setEditing(null);
    showToast("נופק והמלאי עודכן ✓");
  }

  /* Close a request without touching stock: for when the goods were handed over
     outside the app, or the stock count was already corrected by hand. */
  async function markHandled(reqId, note) {
    const req = all.find((r) => r.id === reqId);
    await persistUnitRequests(
      (unitRequests || []).map((r) =>
        r.id === reqId
          ? {
              ...r,
              status: "fulfilled",
              fulfilledAt: Date.now(),
              fulfilledBy: currentUser.name,
              stockUntouched: true,
              managerNote: note || r.managerNote || "",
              issuedItems: (r.items || []).map((i) => ({ ...i })),
            }
          : r
      )
    );
    if (notifyUser && req) {
      await notifyUser(req.unitId, "🧺 הבקשה שלך טופלה ✓", { tab: "unitrequest" });
    }
    setEditing(null);
    showToast("הבקשה סומנה כטופלה (המלאי לא שונה)");
  }

  async function reject() {
    const req = all.find((r) => r.id === editing.requestId);
    await persistUnitRequests(
      (unitRequests || []).map((r) =>
        r.id === editing.requestId ? { ...r, status: "rejected", managerNote: editing.note } : r
      )
    );
    if (notifyUser) await notifyUser(req.unitId, `הבקשה השבועית שלך נדחתה${editing.note ? `: ${editing.note}` : ""}`, { tab: "unitrequest" });
    setEditing(null);
    showToast("הבקשה נדחתה");
  }

  if (editing) {
    const req = all.find((r) => r.id === editing.requestId);
    const shortages = editing.items.filter((i) => stockOf(i.productId) < i.qty);

    return (
      <div>
        <button onClick={() => setEditing(null)} className="mb-3 text-sm font-bold" style={{ color: C.accent }}>
          ← חזרה לרשימה
        </button>

        <ShelfTag accent={C.mustard} style={{ marginBottom: 16 }}>
          <div className="wh-display font-bold" style={{ color: C.ink }}>{req.unitName}</div>
          <div className="text-xs" style={{ color: C.steel }}>שבוע {weekLabel(req.weekOf)}</div>
        </ShelfTag>

        {shortages.length > 0 && (
          <ShelfTag accent={C.stamp} style={{ marginBottom: 16 }}>
            <div className="font-bold text-sm mb-1" style={{ color: C.stamp }}>⚠️ {shortages.length} מוצרים במלאי חסר</div>
            <p className="text-xs" style={{ color: C.steel }}>
              הכמויות למטה כבר הותאמו למה שיש בפועל. אפשר לנפק חלקית ולהזמין את החסר מהספק.
            </p>
          </ShelfTag>
        )}

        <div className="flex justify-between items-center mb-2">
          <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>
            מה לנפק ({editing.items.length} מוצרים)
          </div>
          <div className="flex gap-1">
            <button
              onClick={giveAll}
              className="text-xs font-bold px-2 py-1 rounded-full"
              style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
            >
              נפק הכל
            </button>
            <button
              onClick={giveNone}
              className="text-xs font-bold px-2 py-1 rounded-full"
              style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
            >
              אפס הכל
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 mb-4">
          {editing.items.length === 0 && (
            <ShelfTag accent={C.stamp}>
              <p className="text-sm text-center" style={{ color: C.steel }}>
                הסרת את כל המוצרים. אפשר לדחות את הבקשה, או לחזור ולפתוח אותה מחדש.
              </p>
            </ShelfTag>
          )}
          {editing.items.map((i) => {
            const have = stockOf(i.productId);
            const short = have < i.qty;
            return (
              <ShelfTag key={i.productId} accent={i.give === 0 ? C.kraftDark : short ? C.stamp : C.sage}>
                <div className="flex justify-between items-center">
                  <div className="flex-1">
                    <div className="font-bold text-sm" style={{ color: i.give === 0 ? C.steel : C.ink }}>
                      {i.name}
                      {i.give === 0 && <span className="text-xs font-normal"> (לא ינופק)</span>}
                    </div>
                    <div className="text-xs" style={{ color: short ? C.stamp : C.steel }}>
                      ביקשו {i.qty} {i.unit} · במלאי {have} {i.unit}
                      {short && ` · חסר ${i.qty - have}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-center">
                      <div className="text-xs mb-1" style={{ color: C.steel }}>לנפק</div>
                      <input
                        type="number"
                        value={i.give === 0 ? "" : i.give}
                        onChange={(e) => setGive(i.productId, e.target.value)}
                        placeholder="0"
                        className="w-16 text-center p-2 rounded-2xl border"
                        style={{ borderColor: C.kraftDark }}
                      />
                    </div>
                    <button
                      onClick={() => removeItem(i.productId)}
                      title="הסר מהבקשה"
                      className="rounded-xl font-bold"
                      style={{ background: C.stamp, color: "#fff", width: 32, height: 32, marginTop: 14 }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </ShelfTag>
            );
          })}
        </div>

        <textarea
          value={editing.note}
          onChange={(e) => setEditing({ ...editing, note: e.target.value })}
          placeholder="הערה למעון (אופציונלי)"
          rows={2}
          className="w-full p-3 rounded-2xl border mb-3"
          style={{ borderColor: C.kraftDark }}
        />

        <button onClick={fulfill} className="w-full py-3 rounded-2xl wh-display font-bold mb-2" style={{ background: C.sage, color: "#fff" }}>
          ✓ נפק והורד מהמלאי
        </button>
        <button
          onClick={() => markHandled(editing.requestId, editing.note)}
          className="w-full py-2 rounded-2xl font-bold text-sm mb-2"
          style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
        >
          ✓ סמן כטופל — בלי לשנות מלאי
        </button>
        <p className="text-xs text-center mb-3" style={{ color: C.steel }}>
          השתמש בזה אם מסרת להם ידנית, או אם כבר עדכנת את המלאי בעצמך.
        </p>
        <button onClick={reject} className="w-full py-2 rounded-2xl font-bold text-sm" style={{ background: C.stamp, color: "#fff" }}>
          דחה בקשה
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="wh-display font-black text-lg mb-1" style={{ color: C.ink }}>בקשות מהמחסן</h2>
      <p className="text-xs mb-3" style={{ color: C.steel }}>
        בקשות שיחידות (מעון וכו') שלחו. אישור מנפיק מהמלאי שלך ומוריד את הכמות.
      </p>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab("pending")}
          className="flex-1 py-2 rounded-2xl text-sm font-bold"
          style={{ background: tab === "pending" ? C.ink : C.kraft, color: tab === "pending" ? C.paper : C.ink }}
        >
          ממתינות {pending.length > 0 && `(${pending.length})`}
        </button>
        <button
          onClick={() => setTab("done")}
          className="flex-1 py-2 rounded-2xl text-sm font-bold"
          style={{ background: tab === "done" ? C.ink : C.kraft, color: tab === "done" ? C.paper : C.ink }}
        >
          טופלו
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {shown.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: C.steel }}>
            {tab === "pending" ? "אין בקשות ממתינות" : "אין בקשות שטופלו"}
          </p>
        )}
        {shown.map((r) => {
          const st = UNIT_STATUS[r.status] || UNIT_STATUS.open;
          const shortCount = (r.items || []).filter((i) => stockOf(i.productId) < i.qty).length;
          return (
            <ShelfTag key={r.id} accent={st.color}>
              <div className="flex justify-between items-center">
                <div>
                  <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>{r.unitName}</div>
                  <div className="text-xs" style={{ color: C.steel }}>
                    שבוע {weekLabel(r.weekOf)} · {(r.items || []).length} מוצרים
                    {r.status === "submitted" && shortCount > 0 && (
                      <span style={{ color: C.stamp }}> · {shortCount} בחוסר</span>
                    )}
                    {r.status === "fulfilled" && r.fulfilledBy && (
                      <span> · ע"י {r.fulfilledBy}</span>
                    )}
                    {r.status === "fulfilled" && r.stockUntouched && (
                      <span style={{ color: C.mustard }}> · המלאי לא שונה</span>
                    )}
                  </div>
                </div>
                {r.status === "submitted" ? (
                  <div className="flex flex-col gap-1.5">
                    <button onClick={() => openReview(r)} className="px-4 py-2 rounded-2xl font-bold text-sm" style={{ background: C.ink, color: C.paper }}>
                      בדוק ונפק
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(`לסמן את הבקשה של ${r.unitName} כטופלה? המלאי לא ישתנה.`)) return;
                        markHandled(r.id);
                      }}
                      className="px-4 py-1.5 rounded-2xl font-bold text-xs"
                      style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
                    >
                      ✓ סמן כטופל
                    </button>
                  </div>
                ) : (
                  <span className="text-xs font-bold px-2 py-1 rounded-full" style={{ background: st.color, color: "#fff" }}>
                    {st.label}
                  </span>
                )}
              </div>
            </ShelfTag>
          );
        })}
      </div>
    </div>
  );
}

function OrderRequestsAdmin({ orderRequests, persistOrderRequests, settings, products, showToast, notifyUser, currentUser }) {
  const suppliers = settings?.suppliers || [];
  const requests = [...(orderRequests || [])].sort((a, b) => b.createdAt - a.createdAt);

  const [tab, setTab] = useState("pending");
  const [editing, setEditing] = useState(null); // { requestId, items:[...], supplierId, channel }

  const shown = requests.filter((r) => (tab === "pending" ? r.status === "pending" : r.status !== "pending"));
  const pendingCount = requests.filter((r) => r.status === "pending").length;

  function openReview(r) {
    setEditing({
      requestId: r.id,
      items: r.items.map((i) => ({ ...i })),
      supplierId: r.suggestedSupplierId || "",
      channel: "whatsapp",
    });
  }

  function setItemQty(productId, qty) {
    setEditing((cur) => ({
      ...cur,
      items: cur.items.map((i) => (i.productId === productId ? { ...i, qty: Math.max(0, Number(qty) || 0) } : i)),
    }));
  }
  function removeItem(productId) {
    setEditing((cur) => ({ ...cur, items: cur.items.filter((i) => i.productId !== productId) }));
  }

  async function approveAndSend() {
    const req = requests.find((r) => r.id === editing.requestId);
    const items = editing.items.filter((i) => i.qty > 0);
    if (items.length === 0) return showToast("אין מוצרים עם כמות");

    const supplier = suppliers.find((s) => s.id === editing.supplierId);
    const text = items.map((i) => `- ${i.qty} ${i.unit} ${i.name}`).join("\n");

    const res = sendViaChannel(editing.channel, {
      phone: supplier?.phone || settings?.supplierPhone || "",
      email: supplier?.email || settings?.supplierEmail || "",
      text,
      subject: `הזמנת מלאי — ${todayStr()}`,
    });
    if (!res.ok) return showToast(res.error);

    await persistOrderRequests(
      (orderRequests || []).map((r) =>
        r.id === editing.requestId
          ? {
              ...r,
              status: "approved",
              items,
              approvedSupplierId: editing.supplierId,
              decidedAt: Date.now(),
              decidedByName: currentUser.name,
            }
          : r
      )
    );
    if (notifyUser && req) {
      notifyUser(req.createdById, `✅ בקשת ההזמנה שלך אושרה ונשלחה${supplier ? ` ל${supplier.name}` : ""}`, { tab: "order" });
    }
    setEditing(null);
    showToast("הבקשה אושרה ונשלחה");
  }

  async function reject(r) {
    const reason = window.prompt("סיבת הדחייה (אופציונלי):", "");
    if (reason === null) return; // cancelled
    await persistOrderRequests(
      (orderRequests || []).map((x) =>
        x.id === r.id
          ? { ...x, status: "rejected", rejectReason: reason, decidedAt: Date.now(), decidedByName: currentUser.name }
          : x
      )
    );
    if (notifyUser) {
      notifyUser(r.createdById, `❌ בקשת ההזמנה שלך נדחתה${reason ? `: ${reason}` : ""}`, { tab: "order" });
    }
    setEditing(null);
    showToast("הבקשה נדחתה");
  }

  const statusChip = (r) => {
    if (r.status === "approved") return <span className="text-xs px-2 py-0.5 rounded-full font-bold" style={{ background: C.sage, color: "#fff" }}>אושרה</span>;
    if (r.status === "rejected") return <span className="text-xs px-2 py-0.5 rounded-full font-bold" style={{ background: C.stamp, color: "#fff" }}>נדחתה</span>;
    return <span className="text-xs px-2 py-0.5 rounded-full font-bold" style={{ background: C.mustard, color: "#fff" }}>ממתינה</span>;
  };

  return (
    <div>
      <h2 className="wh-display font-black text-lg mb-1" style={{ color: C.ink }}>בקשות הזמנה</h2>
      <p className="text-xs mb-3" style={{ color: C.steel }}>
        בקשות שמנהלי המטבח שלחו. אפשר לערוך כמויות, לבחור ספק, ואז לאשר ולשלוח.
      </p>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => { setTab("pending"); setEditing(null); }}
          className="flex-1 py-2 rounded-2xl text-sm font-bold"
          style={{ background: tab === "pending" ? C.ink : C.kraft, color: tab === "pending" ? C.paper : C.ink }}
        >
          ממתינות{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </button>
        <button
          onClick={() => { setTab("history"); setEditing(null); }}
          className="flex-1 py-2 rounded-2xl text-sm font-bold"
          style={{ background: tab === "history" ? C.ink : C.kraft, color: tab === "history" ? C.paper : C.ink }}
        >
          היסטוריה
        </button>
      </div>

      {shown.length === 0 && (
        <ShelfTag accent={C.steel}>
          <p className="text-sm text-center mb-2" style={{ color: C.steel }}>
            {tab === "pending" ? "אין בקשות ממתינות ✓" : "אין עדיין היסטוריה"}
          </p>
          {tab === "pending" && (
            <p className="text-xs text-center" style={{ color: C.steel, lineHeight: 1.6 }}>
              כמנהל, ההזמנות שלך יוצאות ישירות לספק ולא נכנסות לכאן. המסך הזה מתמלא רק כשעובד שולח בקשה שדורשת את אישורך.
              <br />
              <b>מחפש את הבקשות של המעון?</b> הן נמצאות בניהול ← "בקשות מהמחסן".
            </p>
          )}
        </ShelfTag>
      )}

      <div className="flex flex-col gap-3">
        {shown.map((r) => {
          const reviewing = editing?.requestId === r.id;
          const accent = r.status === "approved" ? C.sage : r.status === "rejected" ? C.stamp : C.mustard;

          return (
            <ShelfTag key={r.id} accent={accent}>
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="wh-display font-bold text-sm" style={{ color: C.ink }}>
                    {r.createdByName}
                  </div>
                  <div className="text-xs" style={{ color: C.steel }}>
                    {r.source} · {r.items.length} מוצרים ·{" "}
                    {new Date(r.createdAt).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
                {statusChip(r)}
              </div>

              {!reviewing && (
                <div className="flex flex-col gap-1 mb-2">
                  {r.items.map((i) => (
                    <div key={i.productId} className="text-xs flex justify-between" style={{ color: C.steel }}>
                      <span>{i.name}</span>
                      <span className="font-bold" style={{ color: C.ink }}>{i.qty} {i.unit}</span>
                    </div>
                  ))}
                  {r.rejectReason && (
                    <div className="text-xs mt-1" style={{ color: C.stamp }}>סיבה: {r.rejectReason}</div>
                  )}
                </div>
              )}

              {reviewing && (
                <div className="flex flex-col gap-2 mb-2">
                  {editing.items.map((i) => (
                    <div key={i.productId} className="flex items-center gap-2">
                      <span className="flex-1 text-sm" style={{ color: C.ink }}>{i.name}</span>
                      <input
                        type="number"
                        value={i.qty === 0 ? "" : i.qty}
                        onChange={(e) => setItemQty(i.productId, e.target.value)}
                        className="w-16 text-center p-1.5 rounded-xl border"
                        style={{ borderColor: C.kraftDark }}
                      />
                      <span className="text-xs" style={{ color: C.steel }}>{i.unit}</span>
                      <button onClick={() => removeItem(i.productId)} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.stamp, color: "#fff" }}>✕</button>
                    </div>
                  ))}

                  <div>
                    <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>ספק</label>
                    <select
                      value={editing.supplierId}
                      onChange={(e) => setEditing({ ...editing, supplierId: e.target.value })}
                      className="p-2 rounded-2xl border w-full text-sm"
                      style={{ borderColor: C.kraftDark }}
                    >
                      <option value="">ללא ספק (מספר/מייל ברירת מחדל)</option>
                      {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>

                  <ChannelPicker value={editing.channel} onChange={(c) => setEditing({ ...editing, channel: c })} />
                </div>
              )}

              {r.status === "pending" && (
                <div className="flex gap-2 mt-2">
                  {reviewing ? (
                    <>
                      <button onClick={approveAndSend} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.sage, color: "#fff" }}>
                        ✅ אשר ושלח
                      </button>
                      <button onClick={() => reject(r)} className="px-3 py-2 rounded-2xl font-bold text-sm" style={{ background: C.stamp, color: "#fff" }}>
                        דחה
                      </button>
                      <button onClick={() => setEditing(null)} className="px-3 py-2 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink }}>
                        סגור
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => openReview(r)} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.ink, color: C.paper }}>
                        בדוק ואשר
                      </button>
                      <button onClick={() => reject(r)} className="px-3 py-2 rounded-2xl font-bold text-sm" style={{ background: C.stamp, color: "#fff" }}>
                        דחה
                      </button>
                    </>
                  )}
                </div>
              )}
            </ShelfTag>
          );
        })}
      </div>
    </div>
  );
}

function TaskCategoriesAdmin({ taskCategories, persistTaskCategories, showToast }) {
  const ICON_CHOICES = ["⚡", "🔧", "🪚", "❄️", "🧹", "🍳", "🚿", "🔨", "🪟", "🚪", "💡", "🧯", "🌱", "📋"];
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("📋");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("📋");

  const cats = taskCategories || [];

  async function add() {
    if (!name.trim()) return showToast("יש להזין שם קטגוריה");
    if (cats.some((c) => c.name.trim() === name.trim())) return showToast("קטגוריה כזו כבר קיימת");
    await persistTaskCategories([...cats, { id: genId(), name: name.trim(), icon }]);
    setName("");
    setIcon("📋");
    showToast("הקטגוריה נוספה");
  }

  async function saveEdit() {
    if (!editName.trim()) return showToast("יש להזין שם קטגוריה");
    await persistTaskCategories(
      cats.map((c) => (c.id === editingId ? { ...c, name: editName.trim(), icon: editIcon } : c))
    );
    setEditingId(null);
    showToast("הקטגוריה עודכנה");
  }

  async function remove(id) {
    if (!window.confirm("למחוק את הקטגוריה? משימות שכבר משויכות אליה יישארו, אבל יוצגו ללא קטגוריה.")) return;
    await persistTaskCategories(cats.filter((c) => c.id !== id));
    showToast("הקטגוריה נמחקה");
  }

  async function move(id, dir) {
    const idx = cats.findIndex((c) => c.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= cats.length) return;
    const next = [...cats];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    await persistTaskCategories(next);
  }

  return (
    <div>
      <h2 className="wh-display font-black text-lg mb-1" style={{ color: C.ink }}>קטגוריות משימות</h2>
      <p className="text-xs mb-3" style={{ color: C.steel }}>
        חשמל, אינסטלציה, נגרות... הקטגוריה נבחרת ביצירת משימה, ואפשר לסנן לפיה במסך המשימות.
      </p>

      <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="text-sm font-bold" style={{ color: C.ink }}>הוסף קטגוריה</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="שם הקטגוריה (למשל: גינון)"
          className="p-2 rounded-2xl border"
          style={{ borderColor: C.kraftDark }}
        />
        <div>
          <div className="text-xs font-bold mb-1" style={{ color: C.steel }}>בחר אייקון</div>
          <div className="flex flex-wrap gap-1">
            {ICON_CHOICES.map((ic) => (
              <button
                key={ic}
                onClick={() => setIcon(ic)}
                className="text-lg rounded-xl"
                style={{
                  width: 38,
                  height: 38,
                  background: icon === ic ? C.ink : "#fff",
                  border: `1.5px solid ${icon === ic ? C.ink : C.kraftDark}`,
                }}
              >
                {ic}
              </button>
            ))}
          </div>
        </div>
        <button onClick={add} className="py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
          הוסף
        </button>
      </ShelfTag>

      <div className="flex flex-col gap-2">
        {cats.length === 0 && (
          <p className="text-sm text-center py-6" style={{ color: C.steel }}>אין עדיין קטגוריות</p>
        )}
        {cats.map((c, idx) => (
          <ShelfTag key={c.id} accent={categoryColor(c.name)}>
            {editingId === c.id ? (
              <div className="flex flex-col gap-2">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="p-2 rounded-2xl border"
                  style={{ borderColor: C.kraftDark }}
                  autoFocus
                />
                <div className="flex flex-wrap gap-1">
                  {ICON_CHOICES.map((ic) => (
                    <button
                      key={ic}
                      onClick={() => setEditIcon(ic)}
                      className="text-lg rounded-xl"
                      style={{
                        width: 34,
                        height: 34,
                        background: editIcon === ic ? C.ink : "#fff",
                        border: `1.5px solid ${editIcon === ic ? C.ink : C.kraftDark}`,
                      }}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={saveEdit} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.sage, color: "#fff" }}>
                    שמור
                  </button>
                  <button onClick={() => setEditingId(null)} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink }}>
                    ביטול
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-between items-center">
                <div className="font-bold text-sm" style={{ color: C.ink }}>
                  {c.icon || "📋"} {c.name}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => move(c.id, -1)} disabled={idx === 0} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.kraft, opacity: idx === 0 ? 0.4 : 1 }}>▲</button>
                  <button onClick={() => move(c.id, 1)} disabled={idx === cats.length - 1} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.kraft, opacity: idx === cats.length - 1 ? 0.4 : 1 }}>▼</button>
                  <button
                    onClick={() => { setEditingId(c.id); setEditName(c.name); setEditIcon(c.icon || "📋"); }}
                    className="text-xs px-2 py-1 rounded-xl"
                    style={{ background: C.kraft }}
                  >
                    ערוך
                  </button>
                  <button onClick={() => remove(c.id)} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
                </div>
              </div>
            )}
          </ShelfTag>
        ))}
      </div>
    </div>
  );
}

function DishTypesAdmin({ dishTypes, persistDishTypes, showToast }) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");

  async function add() {
    if (!name.trim()) return showToast("יש להזין שם קטגוריה");
    if (dishTypes.some((d) => d.name.trim() === name.trim())) return showToast("קטגוריה כזו כבר קיימת");
    await persistDishTypes([...dishTypes, { id: genId(), name: name.trim() }]);
    setName("");
    showToast("הקטגוריה נוספה");
  }

  async function saveEdit() {
    if (!editName.trim()) return showToast("יש להזין שם");
    await persistDishTypes(dishTypes.map((d) => (d.id === editingId ? { ...d, name: editName.trim() } : d)));
    setEditingId(null);
    setEditName("");
  }

  async function remove(id) {
    await persistDishTypes(dishTypes.filter((d) => d.id !== id));
  }

  function move(id, dir) {
    const idx = dishTypes.findIndex((d) => d.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= dishTypes.length) return;
    const next = [...dishTypes];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    persistDishTypes(next);
  }

  return (
    <div>
      <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>סוגי מנות/קטגוריות בארוחה</div>
        <p className="text-xs" style={{ color: C.steel }}>
          כאן בונים מה מרכיב ארוחה אצלכם - כמה קטגוריות שרוצים (למשל: מנה עיקרית, תוספת, ירקנית, סלט, ללא גלוטן...). כל מוסד יכול לבנות סגנון שונה.
        </p>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="לדוגמה: סלט"
            className="flex-1 p-2 rounded-2xl border"
            style={{ borderColor: C.kraftDark }}
          />
          <button onClick={add} className="px-4 rounded-2xl font-bold" style={{ background: C.sage, color: "#fff" }}>+ הוסף</button>
        </div>
      </ShelfTag>

      <div className="flex flex-col gap-2">
        {dishTypes.length === 0 && (
          <p className="text-sm text-center py-4" style={{ color: C.steel }}>אין עדיין קטגוריות - הוסף למעלה</p>
        )}
        {dishTypes.map((d, idx) => (
          <div key={d.id} className="flex justify-between items-center p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
            {editingId === d.id ? (
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="flex-1 p-1 rounded-xl border ml-2"
                style={{ borderColor: C.kraftDark }}
                autoFocus
              />
            ) : (
              <div className="font-bold text-sm" style={{ color: C.ink }}>{d.name}</div>
            )}
            <div className="flex gap-1 items-center">
              <button onClick={() => move(d.id, -1)} disabled={idx === 0} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.kraft, opacity: idx === 0 ? 0.4 : 1 }}>▲</button>
              <button onClick={() => move(d.id, 1)} disabled={idx === dishTypes.length - 1} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.kraft, opacity: idx === dishTypes.length - 1 ? 0.4 : 1 }}>▼</button>
              {editingId === d.id ? (
                <button onClick={saveEdit} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.sage, color: "#fff" }}>שמור</button>
              ) : (
                <button onClick={() => { setEditingId(d.id); setEditName(d.name); }} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.kraft }}>ערוך</button>
              )}
              <button onClick={() => remove(d.id)} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MenuAdmin({ menuItems, persistMenuItems, products, showToast, weeklyMenu, persistWeeklyMenu, dishTypes }) {
  const emptyEdit = { name: "", category: "בשרי", dishType: "", ingredients: [] };
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(emptyEdit);
  const [editIngProductId, setEditIngProductId] = useState(products[0]?.id || "");
  const [editIngQty, setEditIngQty] = useState(1);

  const [mealCategory, setMealCategory] = useState("בשרי");
  const [rows, setRows] = useState([]);
  const [assignDay, setAssignDay] = useState("");
  const [assignMeal, setAssignMeal] = useState("lunch");

  useEffect(() => {
    if (rows.length === 0 && dishTypes.length > 0) {
      setRows(dishTypes.map((d) => ({ rowId: genId(), dishType: d.id, locked: true, name: "", ingredients: [] })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dishTypes.length]);

  function addRow() {
    setRows((r) => [...r, { rowId: genId(), dishType: "", locked: false, name: "", ingredients: [] }]);
  }
  function removeRow(rowId) {
    setRows((r) => r.filter((row) => row.rowId !== rowId));
  }
  function updateRow(rowId, fields) {
    setRows((r) => r.map((row) => (row.rowId === rowId ? { ...row, ...fields } : row)));
  }
  function addIngredientToRow(rowId, productId, qty) {
    if (!productId) return;
    setRows((r) =>
      r.map((row) => {
        if (row.rowId !== rowId) return row;
        if (row.ingredients.some((i) => i.productId === productId)) {
          showToast("המוצר כבר ברשימה");
          return row;
        }
        return { ...row, ingredients: [...row.ingredients, { productId, qty: Number(qty) }] };
      })
    );
  }
  function removeIngredientFromRow(rowId, productId) {
    setRows((r) =>
      r.map((row) => (row.rowId === rowId ? { ...row, ingredients: row.ingredients.filter((i) => i.productId !== productId) } : row))
    );
  }

  async function createMeal() {
    const filled = rows.filter((r) => r.name.trim());
    if (filled.length === 0) return showToast("מלא לפחות שורה אחת עם שם מנה");
    const missingType = filled.find((r) => !r.dishType);
    if (missingType) return showToast("בחר סוג מנה לכל שורה שמילאת");

    const created = filled.map((r) => ({
      id: genId(),
      name: r.name.trim(),
      category: mealCategory,
      dishType: r.dishType,
      ingredients: r.ingredients,
    }));
    await persistMenuItems([...menuItems, ...created]);

    if (assignDay && persistWeeklyMenu) {
      const daySlots = weeklyMenu[assignDay] || {};
      const slotTypes = { ...(daySlots[assignMeal] || {}) };
      created.forEach((item) => {
        slotTypes[item.dishType] = item.id;
      });
      await persistWeeklyMenu({ ...weeklyMenu, [assignDay]: { ...daySlots, [assignMeal]: slotTypes } });
    }

    setRows(dishTypes.map((d) => ({ rowId: genId(), dishType: d.id, locked: true, name: "", ingredients: [] })));
    setAssignDay("");
    showToast(assignDay ? "הארוחה נשמרה ושובצה ללוח השבועי" : "הארוחה נשמרה");
  }

  function startEdit(m) {
    setEditForm({ ...m });
    setEditingId(m.id);
  }
  function addEditIngredient() {
    if (!editIngProductId) return;
    if (editForm.ingredients.some((i) => i.productId === editIngProductId)) return showToast("המוצר כבר ברשימה");
    setEditForm({ ...editForm, ingredients: [...editForm.ingredients, { productId: editIngProductId, qty: Number(editIngQty) }] });
  }
  function removeEditIngredient(productId) {
    setEditForm({ ...editForm, ingredients: editForm.ingredients.filter((i) => i.productId !== productId) });
  }
  async function saveEdit() {
    if (!editForm.name.trim()) return showToast("יש להזין שם מנה");
    await persistMenuItems(menuItems.map((m) => (m.id === editingId ? { ...editForm, id: editingId } : m)));
    setEditingId(null);
    showToast("המנה עודכנה");
  }

  async function remove(id) {
    await persistMenuItems(menuItems.filter((m) => m.id !== id));
  }

  return (
    <div>
      <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>בניית ארוחה</div>
        <p className="text-xs" style={{ color: C.steel }}>
          שורה אחת לכל סוג מנה שהגדרת (במסך "סוגי מנות"). מלא מה שרלוונטי, ואפשר להוסיף עוד שורות בכפתור למטה.
        </p>

        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>כשרות הארוחה</label>
          <select value={mealCategory} onChange={(e) => setMealCategory(e.target.value)} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="בשרי">בשרי</option>
            <option value="חלבי">חלבי</option>
            <option value="פרווה">פרווה</option>
          </select>
        </div>

        {dishTypes.length === 0 && (
          <p className="text-xs" style={{ color: C.steel }}>אין עדיין סוגי מנות מוגדרים - הוסף במסך ניהול ← סוגי מנות כדי להתחיל.</p>
        )}

        {rows.map((row) => (
          <div key={row.rowId} className="p-3 rounded-2xl" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>
            <div className="flex justify-between items-center mb-2">
              {row.locked ? (
                <div className="font-bold text-sm" style={{ color: C.accent }}>
                  {dishTypes.find((d) => d.id === row.dishType)?.name || "סוג לא ידוע"}
                </div>
              ) : (
                <select
                  value={row.dishType}
                  onChange={(e) => updateRow(row.rowId, { dishType: e.target.value })}
                  className="flex-1 p-2 rounded-xl border text-sm ml-2"
                  style={{ borderColor: C.kraftDark }}
                >
                  <option value="">בחר סוג מנה</option>
                  {dishTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              )}
              <button onClick={() => removeRow(row.rowId)} className="text-xs px-2 py-1 rounded-xl" style={{ background: C.stamp, color: "#fff" }}>✕ הסר שורה</button>
            </div>
            <input
              value={row.name}
              onChange={(e) => updateRow(row.rowId, { name: e.target.value })}
              placeholder="שם המנה"
              className="p-2 rounded-xl border w-full mb-2"
              style={{ borderColor: C.kraftDark }}
            />
            <RowIngredientPicker
              products={products}
              ingredients={row.ingredients}
              onAdd={(pid, qty) => addIngredientToRow(row.rowId, pid, qty)}
              onRemove={(pid) => removeIngredientFromRow(row.rowId, pid)}
            />
          </div>
        ))}

        <button onClick={addRow} className="py-2 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}>
          + הוסף שורת מנה
        </button>

        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שיבוץ ללוח השבועי (אופציונלי)</label>
          <div className="flex gap-2">
            <select value={assignDay} onChange={(e) => setAssignDay(e.target.value)} className="flex-1 p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
              <option value="">— לא לשבץ עכשיו —</option>
              {WEEK_DAYS.map(([val, label], idx) => <option key={val} value={val}>{label} ({weekdayDateLabel(idx)})</option>)}
            </select>
            <select value={assignMeal} onChange={(e) => setAssignMeal(e.target.value)} className="flex-1 p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
              {MEAL_SLOTS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
            </select>
          </div>
        </div>

        <button onClick={createMeal} className="py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
          שמור ארוחה
        </button>
      </ShelfTag>

      {editingId && (
        <ShelfTag accent={C.sage} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>עריכת מנה</div>
          <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} placeholder="שם המנה" />
          <select value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="בשרי">בשרי</option>
            <option value="חלבי">חלבי</option>
            <option value="פרווה">פרווה</option>
          </select>
          <select value={editForm.dishType || ""} onChange={(e) => setEditForm({ ...editForm, dishType: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="">בחר סוג מנה</option>
            {dishTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <div className="flex gap-2">
            <select value={editIngProductId} onChange={(e) => setEditIngProductId(e.target.value)} className="flex-1 p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="number" value={editIngQty} onChange={(e) => setEditIngQty(e.target.value)} className="w-16 p-2 rounded-2xl border text-center" style={{ borderColor: C.kraftDark }} />
            <button onClick={addEditIngredient} className="px-3 rounded-2xl font-bold" style={{ background: C.sage, color: "#fff" }}>+</button>
          </div>
          <div className="flex flex-col gap-1">
            {editForm.ingredients.map((ing) => {
              const p = products.find((pp) => pp.id === ing.productId);
              return (
                <div key={ing.productId} className="flex justify-between items-center text-sm p-1.5 rounded-xl" style={{ background: C.paper }}>
                  <span>{p ? p.name : "מוצר לא ידוע"} — {ing.qty} {p?.unit}</span>
                  <button onClick={() => removeEditIngredient(ing.productId)} className="text-xs px-2 rounded-xl" style={{ background: C.stamp, color: "#fff" }}>✕</button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button onClick={saveEdit} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>שמור שינויים</button>
            <button onClick={() => setEditingId(null)} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>ביטול</button>
          </div>
        </ShelfTag>
      )}

      <div className="flex flex-col gap-2">
        {menuItems.length === 0 && (
          <p className="text-sm text-center py-4" style={{ color: C.steel }}>אין מנות בתפריט עדיין</p>
        )}
        {menuItems.map((m) => (
          <div key={m.id} className="p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
            <div className="flex justify-between items-center">
              <div>
                <div className="font-bold text-sm" style={{ color: C.ink }}>
                  {m.name} <span style={{ color: categoryColor(m.category) }}>· {m.category}</span>
                  {m.dishType && <span style={{ color: C.steel }}> · {dishTypes.find((d) => d.id === m.dishType)?.name || ""}</span>}
                </div>
                <div className="text-xs mt-1" style={{ color: C.steel }}>
                  {m.ingredients.map((ing) => {
                    const p = products.find((pp) => pp.id === ing.productId);
                    return p ? `${p.name} (${ing.qty})` : "";
                  }).filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => startEdit(m)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
                <button onClick={() => remove(m.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RowIngredientPicker({ products, ingredients, onAdd, onRemove }) {
  const [productId, setProductId] = useState(products[0]?.id || "");
  const [qty, setQty] = useState(1);

  return (
    <div>
      <div className="flex gap-2 mb-2">
        <select value={productId} onChange={(e) => setProductId(e.target.value)} className="flex-1 p-2 rounded-xl border text-sm" style={{ borderColor: C.kraftDark }}>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} className="w-14 p-2 rounded-xl border text-center text-sm" style={{ borderColor: C.kraftDark }} />
        <button onClick={() => onAdd(productId, qty)} className="px-3 rounded-xl font-bold" style={{ background: C.sage, color: "#fff" }}>+</button>
      </div>
      <div className="flex flex-col gap-1">
        {ingredients.map((ing) => {
          const p = products.find((pp) => pp.id === ing.productId);
          return (
            <div key={ing.productId} className="flex justify-between items-center text-xs p-1.5 rounded-xl" style={{ background: "#fff" }}>
              <span>{p ? p.name : "מוצר לא ידוע"} — {ing.qty} {p?.unit}</span>
              <button onClick={() => onRemove(ing.productId)} className="text-xs px-2 rounded-xl" style={{ background: C.stamp, color: "#fff" }}>✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Starting set only - the real list lives in settings.productCategories and is editable. */
const DEFAULT_PRODUCT_CATEGORIES = [
  "יבשים",
  "מוצרי ניקיון",
  "חד פעמי",
  "קפואים",
  "קירור / ירקות",
  "אחר",
];

function ProductsAdmin({ products, persistProducts, showToast, settings, persistSettings }) {
  const suppliers = settings?.suppliers || [];
  const categories = settings?.productCategories || DEFAULT_PRODUCT_CATEGORIES;
  const [showCatManager, setShowCatManager] = useState(false);
  const [newCat, setNewCat] = useState("");
  const [renamingCat, setRenamingCat] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  async function persistCategories(next) {
    await persistSettings({ ...settings, productCategories: next });
  }

  async function addCategory() {
    const name = newCat.trim();
    if (!name) return showToast("יש להזין שם קטגוריה");
    if (categories.includes(name)) return showToast("קטגוריה כזו כבר קיימת");
    await persistCategories([...categories, name]);
    setNewCat("");
    showToast(`הקטגוריה "${name}" נוספה`);
  }

  async function renameCategory(oldName) {
    const name = renameValue.trim();
    if (!name) return showToast("יש להזין שם קטגוריה");
    if (name !== oldName && categories.includes(name)) return showToast("קטגוריה כזו כבר קיימת");
    await persistCategories(categories.map((c) => (c === oldName ? name : c)));
    // Keep existing products pointing at the renamed category.
    const affected = products.filter((p) => p.category === oldName);
    if (affected.length > 0) {
      await persistProducts(products.map((p) => (p.category === oldName ? { ...p, category: name } : p)));
    }
    setRenamingCat(null);
    showToast(`שונה ל"${name}"${affected.length ? ` · ${affected.length} מוצרים עודכנו` : ""}`);
  }

  async function removeCategory(name) {
    const inUse = products.filter((p) => p.category === name).length;
    const msg = inUse > 0
      ? `יש ${inUse} מוצרים בקטגוריה "${name}". למחוק אותה? המוצרים יישארו אבל יעברו ל"ללא קטגוריה".`
      : `למחוק את הקטגוריה "${name}"?`;
    if (!window.confirm(msg)) return;
    await persistCategories(categories.filter((c) => c !== name));
    if (inUse > 0) {
      await persistProducts(products.map((p) => (p.category === name ? { ...p, category: "" } : p)));
    }
    showToast("הקטגוריה נמחקה");
  }

  async function moveCategory(name, dir) {
    const idx = categories.indexOf(name);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= categories.length) return;
    const next = [...categories];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    await persistCategories(next);
  }

  const empty = { name: "", barcode: "", quantity: 0, threshold: 1, price: 0, unit: "יח׳", unitsPerCarton: 0, category: "", supplierId: "", unitVisible: true, imageData: null };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [adminSearch, setAdminSearch] = useState("");
  const [visFilter, setVisFilter] = useState("all"); // all | open | hidden
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkThreshold, setBulkThreshold] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkSupplier, setBulkSupplier] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);

  const formRef = useRef(null);

  async function handleProductPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setForm((f) => ({ ...f, imageData: dataUrl }));
    } catch (err) {
      console.error(err);
    } finally {
      setPhotoBusy(false);
    }
  }

  function toggleSelect(id) {
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function applyBulkThreshold() {
    if (selectedIds.length === 0) return showToast("בחר לפחות מוצר אחד");
    if (bulkThreshold === "" || Number(bulkThreshold) < 0) return showToast("הזן סף מינימום תקין");
    const next = products.map((p) =>
      selectedIds.includes(p.id) ? { ...p, threshold: Number(bulkThreshold) } : p
    );
    await persistProducts(next);
    showToast(`עודכן סף מינימום ל-${bulkThreshold} עבור ${selectedIds.length} מוצרים`);
    setSelectedIds([]);
    setBulkThreshold("");
  }

  async function applyBulkCategory() {
    if (selectedIds.length === 0) return showToast("בחר לפחות מוצר אחד");
    if (!bulkCategory) return showToast("בחר קטגוריה");
    const next = products.map((p) =>
      selectedIds.includes(p.id) ? { ...p, category: bulkCategory } : p
    );
    await persistProducts(next);
    showToast(`עודכנה קטגוריה ל-${selectedIds.length} מוצרים`);
    setSelectedIds([]);
    setBulkCategory("");
  }
  async function applyBulkSupplier() {
    if (selectedIds.length === 0) return showToast("בחר לפחות מוצר אחד");
    const next = products.map((p) =>
      selectedIds.includes(p.id) ? { ...p, supplierId: bulkSupplier || "" } : p
    );
    await persistProducts(next);
    const label = bulkSupplier
      ? suppliers.find((sp) => sp.id === bulkSupplier)?.name || "ספק"
      : "ללא ספק";
    showToast(`${selectedIds.length} מוצרים שויכו ל${label}`);
    setSelectedIds([]);
    setBulkSupplier("");
  }

  async function toggleUnitVisible(product) {
    const next = products.map((p) =>
      p.id === product.id ? { ...p, unitVisible: p.unitVisible === false } : p
    );
    await persistProducts(next);
    showToast(
      product.unitVisible === false
        ? `"${product.name}" נפתח להזמנת יחידות`
        : `"${product.name}" הוסתר מהיחידות`
    );
  }

  async function applyBulkVisibility(visible) {
    if (selectedIds.length === 0) return showToast("בחר לפחות מוצר אחד");
    await persistProducts(
      products.map((p) => (selectedIds.includes(p.id) ? { ...p, unitVisible: visible } : p))
    );
    showToast(
      visible
        ? `${selectedIds.length} מוצרים נפתחו להזמנה ליחידות`
        : `${selectedIds.length} מוצרים הוסתרו מהיחידות`
    );
    setSelectedIds([]);
  }


  function selectAllInCategory(cat) {
    const ids = products.filter((p) => (p.category || "ללא קטגוריה") === cat).map((p) => p.id);
    setSelectedIds((cur) => Array.from(new Set([...cur, ...ids])));
  }

  function startEdit(p) {
    setForm(p);
    setEditingId(p.id);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function save() {
    if (!form.name.trim()) return showToast("יש להזין שם מוצר");
    let next;
    if (editingId) {
      next = products.map((p) => (p.id === editingId ? { ...form, id: editingId } : p));
    } else {
      next = [...products, { ...form, id: genId() }];
    }
    await persistProducts(next);
    setForm(empty);
    setEditingId(null);
    showToast("המוצר נשמר");
  }

  async function remove(id) {
    await persistProducts(products.filter((p) => p.id !== id));
  }

  function normKey(s) { return String(s).trim().toLowerCase(); }
  function pickField(row, keys) {
    for (const k of Object.keys(row)) {
      if (keys.includes(normKey(k))) return row[k];
    }
    return "";
  }

  async function applyImportedRows(rows) {
    const suppliers = settings?.suppliers || [];
    const newSuppliersFound = [];

    function resolveSupplierId(supplierName) {
      if (!supplierName) return "";
      const clean = supplierName.trim();
      if (!clean) return "";
      const existing = suppliers.find((s) => s.name.trim() === clean);
      if (existing) return existing.id;
      const alreadyQueued = newSuppliersFound.find((s) => s.name === clean);
      if (alreadyQueued) return alreadyQueued.id;
      const id = genId();
      newSuppliersFound.push({ id, name: clean, phone: "" });
      return id;
    }

    const imported = rows
      .map((row) => {
        const name = pickField(row, ["name", "שם", "שם מוצר", "מוצר"]);
        if (!name) return null;
        const barcode = String(pickField(row, ["barcode", "ברקוד", "קוד"]) || "");
        const quantity = Number(pickField(row, ["quantity", "כמות", "מלאי"]) || 0);
        const threshold = Number(pickField(row, ["threshold", "סף", "סף מינימום", "סף מינ׳"]) || 1);
        const price = Number(pickField(row, ["price", "מחיר"]) || 0);
        const unit = String(pickField(row, ["unit", "יחידה", "יח׳"]) || "יח׳");
        const unitsPerCarton = Number(pickField(row, ["unitspercarton", "יחידות בקרטון", "בקרטון", "יח בקרטון"]) || 0);
        const category = String(pickField(row, ["category", "קטגוריה", "קטגוריא"]) || "");
        const supplierName = String(pickField(row, ["supplier", "ספק"]) || "");
        const supplierId = resolveSupplierId(supplierName);
        return { name: String(name), barcode, quantity, threshold, price, unit, unitsPerCarton, category, supplierId };
      })
      .filter(Boolean);

    if (imported.length === 0) {
      showToast("לא נמצאו שורות עם שם מוצר תקין");
      return;
    }

    if (newSuppliersFound.length > 0 && persistSettings) {
      await persistSettings({ ...settings, suppliers: [...suppliers, ...newSuppliersFound] });
    }

    let next = [...products];
    let added = 0, updated = 0;
    for (const item of imported) {
      const normName = (s) => String(s).trim().toLowerCase();
      const existingIdx = item.barcode
        ? next.findIndex((p) => p.barcode && p.barcode === item.barcode)
        : next.findIndex((p) => normName(p.name) === normName(item.name));
      if (existingIdx >= 0) {
        next[existingIdx] = { ...next[existingIdx], ...item };
        updated++;
      } else {
        next.push({ ...item, id: genId() });
        added++;
      }
    }
    await persistProducts(next);
    const supplierNote = newSuppliersFound.length > 0 ? ` (נוצרו ${newSuppliersFound.length} ספקים חדשים - הוסף להם טלפון בהגדרות)` : "";
    showToast(`יובאו ${added} מוצרים חדשים, עודכנו ${updated}${supplierNote}`);
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      await applyImportedRows(rows);
    } catch (err) {
      console.error(err);
      showToast("שגיאה בקריאת הקובץ. ודא שזה קובץ Excel או CSV תקין");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handlePasteImport() {
    if (!pasteText.trim()) return showToast("הדבק קודם נתונים בתיבה");
    setImporting(true);
    try {
      const wb = XLSX.read(pasteText, { type: "string" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      await applyImportedRows(rows);
      setPasteText("");
      setPasteMode(false);
    } catch (err) {
      console.error(err);
      showToast("שגיאה בפענוח הטקסט שהודבק");
    } finally {
      setImporting(false);
    }
  }

  function exportToExcel() {
    const rows = products.map((p) => ({
      "שם מוצר": p.name,
      "ברקוד": p.barcode || "",
      "כמות": p.quantity,
      "יחידות בקרטון": p.unitsPerCarton || "",
      "סף מינימום": p.threshold,
      "מחיר": p.price,
      "יחידה": p.unit,
      "קטגוריה": p.category || "",
      "ספק": suppliers.find((s) => s.id === p.supplierId)?.name || "",
    }));
    if (rows.length === 0) {
      rows.push({
        "שם מוצר": "", "ברקוד": "", "כמות": "", "יחידות בקרטון": "",
        "סף מינימום": "", "מחיר": "", "יחידה": "", "קטגוריה": "", "ספק": "",
      });
    }
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = [
      { wch: 26 }, { wch: 20 }, { wch: 10 }, { wch: 16 },
      { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 20 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Products");
    XLSX.writeFile(wb, "products-export.xlsx");
    showToast("הקובץ יורד עכשיו");
  }

  return (
    <div>
      <div className="mb-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFile}
          className="hidden"
        />
        <div className="flex gap-2 mb-2">
          <button
            onClick={exportToExcel}
            className="flex-1 py-2 rounded-2xl font-bold text-sm"
            style={{ background: C.accent, color: "#fff" }}
          >
            📤 ייצוא טבלה לאקסל
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="flex-1 py-2 rounded-2xl font-bold text-sm"
            style={{ background: C.mustard, color: C.ink }}
          >
            {importing ? "מייבא..." : "📥 בחר קובץ אקסל/CSV"}
          </button>
          <button
            onClick={() => setPasteMode((v) => !v)}
            className="flex-1 py-2 rounded-2xl font-bold text-sm"
            style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
          >
            📋 הדבקת נתונים
          </button>
        </div>
        <p className="text-xs mt-1 text-center" style={{ color: C.steel }}>
          עמודות מזוהות: שם מוצר, ברקוד, כמות, סף מינימום, מחיר, יחידה. אם יש ברקוד - מתאים לפיו; אם אין ברקוד - מתאים לפי שם מדויק. במקרה של התאמה, המוצר מתעדכן ולא מתווסף כפול.
        </p>

        {pasteMode && (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs" style={{ color: C.steel }}>
              פתח את קובץ האקסל, סמן את כל הטבלה כולל שורת הכותרות, העתק (Ctrl+C), והדבק כאן:
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"שם מוצר\tברקוד\tכמות\tסף מינימום\tמחיר\tיחידה\nאורז\t123456\t20\t5\t24.9\tשק"}
              rows={6}
              className="p-2 rounded-2xl border text-xs"
              style={{ borderColor: C.kraftDark, direction: "ltr", fontFamily: "monospace" }}
            />
            <button
              onClick={handlePasteImport}
              disabled={importing}
              className="py-2 rounded-2xl font-bold text-sm"
              style={{ background: C.sage, color: "#fff" }}
            >
              {importing ? "מייבא..." : "ייבא מהטקסט שהודבק"}
            </button>
          </div>
        )}
      </div>

      <div ref={formRef}>
      <ShelfTag accent={C.sage} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>
          {editingId ? "עריכת מוצר" : "הוספת מוצר חדש"}
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שם מוצר</label>
          <input placeholder="שם מוצר" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>ברקוד</label>
          <input placeholder="ברקוד" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>כמות במלאי</label>
            <input type="number" placeholder="כמות" value={form.quantity === 0 ? "" : form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value === "" ? 0 : Number(e.target.value) })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>סף מינימום</label>
            <input type="number" placeholder="סף מינ׳" value={form.threshold === 0 ? "" : form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value === "" ? 0 : Number(e.target.value) })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מחיר ליחידה (₪)</label>
            <input type="number" placeholder="מחיר ליחידה" value={form.price === 0 ? "" : form.price} onChange={(e) => setForm({ ...form, price: e.target.value === "" ? 0 : Number(e.target.value) })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>יחידת מידה</label>
            <input placeholder="ק״ג, יח׳..." value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>יחידות בקרטון (אופציונלי)</label>
          <input type="number" placeholder="יחידות בקרטון" value={form.unitsPerCarton || ""} onChange={(e) => setForm({ ...form, unitsPerCarton: Number(e.target.value) })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-xs font-bold" style={{ color: C.steel }}>קטגוריה</label>
            <button
              onClick={() => setShowCatManager((v) => !v)}
              className="text-xs font-bold underline"
              style={{ color: C.accent }}
            >
              {showCatManager ? "סגור ניהול קטגוריות" : "⚙️ נהל קטגוריות"}
            </button>
          </div>
          <select value={form.category || ""} onChange={(e) => setForm({ ...form, category: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="">ללא קטגוריה</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          {showCatManager && (
            <div className="mt-2 p-3 rounded-2xl" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>
              <div className="flex gap-2 mb-3">
                <input
                  value={newCat}
                  onChange={(e) => setNewCat(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addCategory()}
                  placeholder="שם קטגוריה חדשה"
                  className="flex-1 p-2 rounded-xl border text-sm"
                  style={{ borderColor: C.kraftDark, background: "#fff" }}
                />
                <button onClick={addCategory} className="px-4 rounded-xl font-bold text-sm" style={{ background: C.ink, color: C.paper }}>
                  הוסף
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                {categories.map((c, idx) => {
                  const count = products.filter((p) => p.category === c).length;
                  const col = categoryColor(c);
                  return (
                    <div key={c} className="flex items-center gap-1.5 p-2 rounded-xl" style={{ background: "#fff", borderRight: `4px solid ${col}` }}>
                      {renamingCat === c ? (
                        <>
                          <input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && renameCategory(c)}
                            className="flex-1 p-1.5 rounded-lg border text-sm"
                            style={{ borderColor: C.kraftDark }}
                            autoFocus
                          />
                          <button onClick={() => renameCategory(c)} className="text-xs px-2 py-1 rounded-lg font-bold" style={{ background: C.sage, color: "#fff" }}>שמור</button>
                          <button onClick={() => setRenamingCat(null)} className="text-xs px-2 py-1 rounded-lg" style={{ background: C.kraft, color: C.ink }}>ביטול</button>
                        </>
                      ) : (
                        <>
                          <span className="flex-1 text-sm font-bold" style={{ color: C.ink }}>
                            {c} <span className="font-normal text-xs" style={{ color: C.steel }}>({count})</span>
                          </span>
                          <button onClick={() => moveCategory(c, -1)} disabled={idx === 0} className="text-xs px-1.5 py-1 rounded-lg" style={{ background: C.kraft, opacity: idx === 0 ? 0.35 : 1 }}>▲</button>
                          <button onClick={() => moveCategory(c, 1)} disabled={idx === categories.length - 1} className="text-xs px-1.5 py-1 rounded-lg" style={{ background: C.kraft, opacity: idx === categories.length - 1 ? 0.35 : 1 }}>▼</button>
                          <button onClick={() => { setRenamingCat(c); setRenameValue(c); }} className="text-xs px-2 py-1 rounded-lg" style={{ background: C.kraft, color: C.ink }}>שנה שם</button>
                          <button onClick={() => removeCategory(c)} className="text-xs px-2 py-1 rounded-lg" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs mt-2" style={{ color: C.steel }}>
                שינוי שם מעדכן אוטומטית את כל המוצרים בקטגוריה.
              </p>
            </div>
          )}
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>ספק קבוע למוצר (אופציונלי)</label>
          <select value={form.supplierId || ""} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="">ללא ספק קבוע</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {suppliers.length === 0 && (
            <p className="text-xs mt-1" style={{ color: C.steel }}>הוסף ספקים במסך ניהול ← הגדרות כדי לבחור כאן.</p>
          )}
        </div>
        <div className="p-3 rounded-2xl" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>
          <label className="flex items-start gap-2 text-sm" style={{ color: C.ink }}>
            <input
              type="checkbox"
              checked={form.unitVisible !== false}
              onChange={(e) => setForm({ ...form, unitVisible: e.target.checked })}
              style={{ marginTop: 4 }}
            />
            <span>
              <b>👁️ פתוח להזמנת יחידות</b>
              <span className="block text-xs" style={{ color: C.steel }}>
                יחידות כמו המעון יראו את המוצר ויוכלו להזמין אותו ממך. הורד את הסימון כדי להסתיר אותו מהן.
              </span>
            </span>
          </label>
        </div>
        <div>
          <label className="inline-block px-3 py-2 rounded-full text-sm font-bold cursor-pointer" style={{ background: C.paper, border: `1.5px solid ${C.kraftDark}`, color: C.ink }}>
            {photoBusy ? "טוען תמונה..." : form.imageData ? "📷 החלף תמונת מוצר" : "📷 צרף תמונת מוצר"}
            <input type="file" accept="image/*" capture="environment" onChange={handleProductPhoto} className="hidden" />
          </label>
          {form.imageData && (
            <div className="mt-2 relative inline-block">
              <img src={form.imageData} alt="" className="rounded-2xl" style={{ maxHeight: 140, maxWidth: "100%" }} />
              <button onClick={() => setForm({ ...form, imageData: null })} className="absolute -top-2 -left-2 w-6 h-6 rounded-full font-bold text-xs" style={{ background: C.stamp, color: "#fff" }}>✕</button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
            {editingId ? "שמור שינויים" : "הוסף מוצר"}
          </button>
          {editingId && (
            <button onClick={() => { setForm(empty); setEditingId(null); }} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>
              ביטול
            </button>
          )}
        </div>
      </ShelfTag>
      </div>

      <input
        value={adminSearch}
        onChange={(e) => setAdminSearch(e.target.value)}
        placeholder="חיפוש מוצר..."
        className="p-2 rounded-2xl border w-full mb-3"
        style={{ borderColor: C.kraftDark, background: "#fff" }}
      />

      <div className="flex gap-2 mb-3">
        {[
          ["all", `הכל (${products.length})`],
          ["open", `👁️ פתוחים ליחידות (${products.filter((p) => p.unitVisible !== false).length})`],
          ["hidden", `🚫 מוסתרים (${products.filter((p) => p.unitVisible === false).length})`],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setVisFilter(id)}
            className="flex-1 py-2 rounded-2xl text-xs font-bold"
            style={{
              background: visFilter === id ? C.ink : "#fff",
              color: visFilter === id ? "#fff" : C.ink,
              border: `1px solid ${C.kraftDark}`,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {selectedIds.length > 0 && (
        <ShelfTag accent={C.accent} style={{ marginBottom: 16 }}>
          <div className="text-sm font-bold mb-2" style={{ color: C.ink }}>
            {selectedIds.length} מוצרים נבחרו
          </div>
          <div className="flex gap-2 mb-2">
            <input
              type="number"
              value={bulkThreshold}
              onChange={(e) => setBulkThreshold(e.target.value)}
              placeholder="סף מינימום חדש"
              className="flex-1 p-2 rounded-2xl border text-center"
              style={{ borderColor: C.kraftDark }}
            />
            <button onClick={applyBulkThreshold} className="px-4 rounded-2xl font-bold text-sm" style={{ background: C.sage, color: "#fff" }}>
              עדכן סף
            </button>
          </div>
          <div className="flex gap-2 mb-2">
            <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} className="flex-1 p-2 rounded-2xl border text-sm" style={{ borderColor: C.kraftDark }}>
              <option value="">בחר קטגוריה חדשה</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={applyBulkCategory} className="px-4 rounded-2xl font-bold text-sm" style={{ background: C.accent, color: "#fff" }}>
              עדכן קטגוריה
            </button>
          </div>
          <div className="flex gap-2 mb-2">
            <select value={bulkSupplier} onChange={(e) => setBulkSupplier(e.target.value)} className="flex-1 p-2 rounded-2xl border text-sm" style={{ borderColor: C.kraftDark }}>
              <option value="">ללא ספק קבוע</option>
              {suppliers.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
            <button onClick={applyBulkSupplier} className="px-4 rounded-2xl font-bold text-sm" style={{ background: C.mustard, color: C.ink }}>
              שייך ספק
            </button>
          </div>
          <div className="flex gap-2 mb-2">
            <button onClick={() => applyBulkVisibility(true)} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.sage, color: "#fff" }}>
              👁️ פתח להזמנת יחידות
            </button>
            <button onClick={() => applyBulkVisibility(false)} className="flex-1 py-2 rounded-2xl font-bold text-sm" style={{ background: C.steel, color: "#fff" }}>
              🚫 הסתר מיחידות
            </button>
          </div>
          {suppliers.length === 0 && (
            <p className="text-xs mb-2" style={{ color: C.steel }}>אין ספקים מוגדרים - הוסף במסך ניהול ← הגדרות.</p>
          )}
          <button onClick={() => setSelectedIds([])} className="w-full py-2 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink }}>
            נקה בחירה
          </button>
        </ShelfTag>
      )}

      <div className="flex flex-col gap-4">
        {Object.entries(
          products
            .filter((p) => !adminSearch || p.name.includes(adminSearch) || (p.barcode || "").includes(adminSearch))
            .filter((p) =>
              visFilter === "all"
                ? true
                : visFilter === "open"
                ? p.unitVisible !== false
                : p.unitVisible === false
            )
            .reduce((acc, p) => {
              const cat = p.category || "ללא קטגוריה";
              (acc[cat] = acc[cat] || []).push(p);
              return acc;
            }, {})
        ).map(([cat, items]) => (
          <div key={cat}>
            <div className="flex justify-between items-center mb-2">
              <div className="wh-display font-bold text-sm" style={{ color: C.steel }}>{cat} ({items.length})</div>
              <button onClick={() => selectAllInCategory(cat)} className="text-xs px-2 py-1 rounded-full" style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}>
                סמן את כל הקטגוריה
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {items.map((p) => {
                const openToUnits = p.unitVisible !== false;
                return (
                <div key={p.id} className="flex justify-between items-center p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}`, borderRight: `5px solid ${openToUnits ? C.sage : C.steel}` }}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(p.id)}
                      onChange={() => toggleSelect(p.id)}
                    />
                    {p.imageData && <img src={p.imageData} alt="" className="rounded-xl" style={{ width: 40, height: 40, objectFit: "cover" }} />}
                    <div>
                      <div className="font-bold text-sm flex items-center gap-1.5" style={{ color: C.ink }}>
                        {p.name}
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-bold whitespace-nowrap"
                          style={{ background: openToUnits ? C.sage : C.steel, color: "#fff" }}
                        >
                          {openToUnits ? "👁️ פתוח ליחידות" : "🚫 מוסתר"}
                        </span>
                      </div>
                      <div className="text-xs" style={{ color: C.steel }}>₪{Number(p.price).toFixed(2)} · {p.quantity} {p.unit} · סף: {p.threshold}</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => toggleUnitVisible(p)}
                      title={openToUnits ? "הסתר מהיחידות" : "פתח להזמנת יחידות"}
                      className="text-xs px-2 py-1 rounded-2xl"
                      style={{ background: openToUnits ? C.sage : C.kraft, color: openToUnits ? "#fff" : C.steel }}
                    >
                      {openToUnits ? "👁️" : "🚫"}
                    </button>
                    <button onClick={() => startEdit(p)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
                    <button onClick={() => remove(p.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsersAdmin({ users, updateUserProfile, deleteUserProfile, showToast, currentUser, settings, persistSettings, taskCategories }) {
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(null);
  const [copied, setCopied] = useState(false);
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteChannel, setInviteChannel] = useState("whatsapp");
  const [apkUrl, setApkUrl] = useState(settings?.apkUrl || "");

  async function saveApkUrl() {
    await persistSettings({ ...settings, apkUrl: apkUrl.trim() });
    showToast("קישור ה-APK נשמר");
  }

  async function importInviteContact() {
    if (!("contacts" in navigator && "ContactsManager" in window)) {
      showToast("ייבוא מאנשי קשר זמין רק ב-Chrome באנדרואיד");
      return;
    }
    try {
      const contacts = await navigator.contacts.select(["name", "tel", "email"], { multiple: false });
      if (!contacts || contacts.length === 0) return;
      const c = contacts[0];
      let digits = String(c.tel?.[0] || "").replace(/\D/g, "");
      if (digits.startsWith("0")) digits = "972" + digits.slice(1);
      const mail = (c.email?.[0] || "").trim();

      if (digits) setInvitePhone(digits);
      if (mail) setInviteEmail(mail);

      // Land them on a channel we actually have a destination for.
      if (inviteChannel === "email" && !mail && digits) setInviteChannel("whatsapp");
      if (inviteChannel !== "email" && !digits && mail) setInviteChannel("email");

      if (!digits && !mail) {
        showToast("לאיש הקשר הזה אין טלפון או מייל שמורים");
        return;
      }
      showToast(`נטען: ${c.name?.[0] || "איש קשר"}`);
    } catch (e) {
      console.error("contact import failed", e);
      showToast("הייבוא בוטל או נכשל");
    }
  }

  function startEdit(u) {
    setForm({ contactEmail: "", ...u });
    setEditingId(u.id);
  }

  async function save() {
    await updateUserProfile(editingId, {
      display_name: form.name,
      phone: form.phone,
      contact_email: (form.contactEmail || "").trim(),
      role: form.role,
      permissions: form.permissions,
    });
    setEditingId(null);
    setForm(null);
    showToast("העובד עודכן");
  }

  async function remove(u) {
    if (u.id === currentUser.id) return showToast("אי אפשר למחוק את עצמך");
    if (!window.confirm(`למחוק את ${u.name} מהארגון? הוא לא יוכל יותר לגשת לנתונים.`)) return;
    try {
      await deleteUserProfile(u.id);
      showToast("העובד הוסר מהארגון");
    } catch (e) {
      showToast("שגיאה במחיקה: " + (e?.message || ""));
    }
  }

  function copyOrgId() {
    navigator.clipboard?.writeText(currentUser.orgId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function sendInvite() {
    const siteUrl = typeof window !== "undefined" ? window.location.origin : "";
    const apkUrl = (settings?.apkUrl || "").trim();
    // One tap: this link pre-fills the org code, so nobody has to copy anything.
    const joinUrl = `${siteUrl}/?join=${encodeURIComponent(currentUser.orgId)}`;

    const lines = [
      "שלום! מוזמן/ת להצטרף לאפליקציית ניהול המשימות והמלאי שלנו.",
      "",
      "👈 לחץ על הקישור והירשם - הכל כבר ממולא:",
      joinUrl,
    ];
    if (apkUrl) lines.push("", `📱 להורדת האפליקציה לאנדרואיד: ${apkUrl}`);
    lines.push(
      "",
      "──────────",
      "אם הקישור לא עובד, הירשם ידנית עם קוד הארגון הזה:",
      "",
      currentUser.orgId, // alone on its own line - one long-press selects just the code
      ""
    );

    const res = sendViaChannel(inviteChannel, {
      phone: invitePhone,
      email: inviteEmail,
      text: lines.join("\n"),
      subject: "הזמנה להצטרף לאפליקציית ניהול המשימות והמלאי",
    });
    if (!res.ok) showToast(res.error);
  }

  return (
    <div>
      <ShelfTag accent={C.accent} style={{ marginBottom: 16 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>הזמנת עובד חדש</div>
        <p className="text-xs mb-2" style={{ color: C.steel }}>
          עובדים לא נוצרים כאן ישירות - כל אחד נרשם בעצמו, אבל אפשר לשלוח לו הזמנה מוכנה בוואטסאפ עם כל ההוראות:
        </p>
        <div className="mb-2">
          <ChannelPicker value={inviteChannel} onChange={setInviteChannel} label="" />
        </div>
        <div className="flex gap-2 mb-2">
          {inviteChannel === "email" ? (
            <input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              type="email"
              placeholder="worker@example.com"
              className="flex-1 p-2 rounded-xl border text-sm"
              style={{ borderColor: C.kraftDark, direction: "ltr" }}
            />
          ) : (
            <input
              value={invitePhone}
              onChange={(e) => setInvitePhone(e.target.value)}
              placeholder={inviteChannel === "sms" ? "972501234567" : "972501234567 (אופציונלי)"}
              className="flex-1 p-2 rounded-xl border text-sm"
              style={{ borderColor: C.kraftDark, direction: "ltr" }}
            />
          )}
          <button
            onClick={importInviteContact}
            title="ייבא מאנשי קשר"
            className="px-3 rounded-xl font-bold text-sm"
            style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
          >
            📇
          </button>
          <button
            onClick={sendInvite}
            className="px-3 rounded-xl font-bold text-sm whitespace-nowrap"
            style={{ background: channelMeta(inviteChannel).color, color: "#fff" }}
          >
            שלח הזמנה
          </button>
        </div>
        <div className="p-2 rounded-xl text-xs mb-2" style={{ background: C.paper, color: C.steel, border: `1px solid ${C.kraftDark}` }}>
          ℹ️ עובד חדש שנרשם רואה <b>משימות בלבד</b> כברירת מחדל. פתח לו מסכים נוספים כאן למטה, בעריכת העובד.
        </div>
        <p className="text-xs mb-1" style={{ color: C.steel }}>או שתף ידנית את מזהה הארגון:</p>        <div className="p-2 rounded-xl text-xs mb-2" style={{ background: C.ink, color: "#fff", direction: "ltr", wordBreak: "break-all", fontFamily: "monospace" }}>
          {currentUser.orgId}
        </div>
        <button onClick={copyOrgId} className="w-full py-1.5 rounded-xl text-xs font-bold mb-2" style={{ background: C.paper, color: C.ink }}>
          {copied ? "הועתק ✓" : "העתק מזהה ארגון"}
        </button>
        <button
          onClick={async () => {
            const link = `${window.location.origin}/?join=${encodeURIComponent(currentUser.orgId)}`;
            try {
              await navigator.clipboard.writeText(link);
              showToast("קישור ההזמנה הועתק ✓");
            } catch (e) {
              showToast("לא ניתן להעתיק - העתק ידנית מהשדה למעלה");
            }
          }}
          className="w-full py-1.5 rounded-xl text-xs font-bold mb-3"
          style={{ background: C.accent, color: "#fff" }}
        >
          🔗 העתק קישור הזמנה (ממלא את הקוד לבד)
        </button>

        <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>
          קישור להורדת APK (אופציונלי - ייכנס להזמנה)
        </label>
        <div className="flex gap-2">
          <input
            value={apkUrl}
            onChange={(e) => setApkUrl(e.target.value)}
            placeholder="https://.../app.apk"
            className="flex-1 p-2 rounded-xl border text-sm"
            style={{ borderColor: C.kraftDark, direction: "ltr" }}
          />
          <button onClick={saveApkUrl} className="px-3 rounded-xl font-bold text-sm" style={{ background: C.ink, color: C.paper }}>
            שמור
          </button>
        </div>
        <p className="text-xs mt-1" style={{ color: C.steel }}>
          אם ריק - ההזמנה תכיל רק את קישור האתר (שממנו אפשר להתקין כ-PWA).
        </p>
      </ShelfTag>

      {editingId && form && (
        <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>עריכת עובד</div>
          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שם</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>טלפון (לוואטסאפ / SMS)</label>
            <div className="flex gap-2">
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="972501234567" className="flex-1 p-2 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
              <button
                onClick={async () => {
                  if (!("contacts" in navigator && "ContactsManager" in window)) {
                    showToast("ייבוא מאנשי קשר זמין רק ב-Chrome באנדרואיד");
                    return;
                  }
                  try {
                    const contacts = await navigator.contacts.select(["name", "tel", "email"], { multiple: false });
                    if (!contacts || contacts.length === 0) return;
                    const c = contacts[0];
                    let digits = String(c.tel?.[0] || "").replace(/\D/g, "");
                    if (digits.startsWith("0")) digits = "972" + digits.slice(1);
                    setForm({
                      ...form,
                      phone: digits || form.phone,
                      name: c.name?.[0] || form.name,
                      contactEmail: (c.email?.[0] || "").trim() || form.contactEmail || "",
                    });
                  } catch (e) {
                    console.error(e);
                    if (window.matchMedia("(display-mode: standalone)").matches) {
                      showToast("ייבוא מאנשי קשר לא עובד באפליקציה המותקנת - פתח את האתר בכרום רגיל ונסה שוב");
                    } else {
                      showToast("שגיאה בייבוא איש קשר: " + (e?.message || "לא ידועה"));
                    }
                  }
                }}
                className="px-3 rounded-2xl text-sm font-bold"
                style={{ background: C.accent, color: "#fff" }}
              >
                📇
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מייל ליצירת קשר</label>
            <input
              value={form.contactEmail || ""}
              onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
              type="email"
              placeholder={form.loginEmail || "worker@example.com"}
              className="p-2 rounded-2xl border w-full"
              style={{ borderColor: C.kraftDark, direction: "ltr" }}
            />
            {form.loginEmail && (
              <p className="text-xs mt-1" style={{ color: C.steel }}>
                מייל ההתחברות שלו: <span style={{ direction: "ltr", display: "inline-block" }}>{form.loginEmail}</span> (לא ניתן לשינוי מכאן)
              </p>
            )}
          </div>
          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>תפקיד</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <p className="text-xs mt-1" style={{ color: C.steel }}>
              {ROLES.find((r) => r.id === form.role)?.desc}
            </p>
          </div>

          {form.role !== "manager" && (() => {
            const perms = { ...DEFAULT_PERMISSIONS, ...(form.permissions || {}) };
            const adminPerms = perms.admin || {};
            const setPerm = (key, val) => setForm({ ...form, permissions: { ...perms, [key]: val } });
            const setAdminPerm = (key, val) =>
              setForm({ ...form, permissions: { ...perms, admin: { ...adminPerms, [key]: val } } });

            return (
              <>
                <div>
                  <label className="text-xs font-bold block mb-2" style={{ color: C.steel }}>מסכים ראשיים</label>
                  <div className="flex flex-col gap-2">
                    {[
                      ["inventory", "מלאי"],
                      ["order", "הזמנה"],
                      ["tasks", "משימות"],
                    ].map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 text-sm" style={{ color: C.ink }}>
                        <input
                          type="checkbox"
                          checked={perms[key] !== false}
                          onChange={(e) => setPerm(key, e.target.checked)}
                        />
                        {label}
                      </label>
                    ))}
                    <label className="flex items-start gap-2 text-sm" style={{ color: C.ink }}>
                      <input
                        type="checkbox"
                        checked={perms.unitRequest === true}
                        onChange={(e) => setPerm("unitRequest", e.target.checked)}
                        style={{ marginTop: 4 }}
                      />
                      <span>
                        בקשה מהמחסן
                        <span className="block text-xs" style={{ color: C.steel }}>
                          ליחידות כמו המעון - מזמינים מהמלאי שלך ואתה מנפיק. אם זו ההרשאה היחידה, הם יראו רק את המסך הזה.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                {perms.tasks !== false && (
                  <div className="p-3 rounded-2xl" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>
                    <label className="text-xs font-bold block mb-2" style={{ color: C.steel }}>
                      אילו משימות הוא רואה?
                    </label>
                    <select
                      value={perms.taskScope || "own"}
                      onChange={(e) => setPerm("taskScope", e.target.value)}
                      className="p-2 rounded-2xl border w-full mb-2"
                      style={{ borderColor: C.kraftDark }}
                    >
                      <option value="own">רק משימות שמשויכות אליו</option>
                      <option value="categories">משימות שלו + קטגוריות שאבחר</option>
                      <option value="all">כל המשימות בארגון</option>
                    </select>

                    {(perms.taskScope || "own") === "categories" && (
                      <div>
                        <div className="text-xs font-bold mb-1" style={{ color: C.steel }}>
                          קטגוריות שהוא רשאי לראות (גם אם לא שויכו אליו):
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {(taskCategories || []).map((c) => {
                            const allowed = perms.visibleTaskCategories || [];
                            const on = allowed.includes(c.id);
                            const col = categoryColor(c.name);
                            return (
                              <button
                                key={c.id}
                                onClick={() =>
                                  setPerm(
                                    "visibleTaskCategories",
                                    on ? allowed.filter((x) => x !== c.id) : [...allowed, c.id]
                                  )
                                }
                                className="px-3 py-1.5 rounded-full text-xs font-bold"
                                style={{
                                  background: on ? col : "#fff",
                                  color: on ? "#fff" : col,
                                  border: `1.5px solid ${col}`,
                                }}
                              >
                                {c.icon || "📋"} {c.name}
                              </button>
                            );
                          })}
                        </div>
                        {(taskCategories || []).length === 0 && (
                          <p className="text-xs" style={{ color: C.steel }}>
                            אין קטגוריות מוגדרות - הוסף בניהול ← קטגוריות משימות.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {form.role === "supervisor" && (
                  <div className="p-3 rounded-2xl" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>
                    <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>
                      מסכי ניהול שמנהל המטבח יראה
                    </label>
                    <p className="text-xs mb-2" style={{ color: C.steel }}>
                      סמן רק את מה שאתה רוצה שיראה. אם לא תסמן כלום - הוא לא יראה את תפריט "ניהול" בכלל.
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {ADMIN_SECTIONS.map((sec) => (
                        <label key={sec.id} className="flex items-center gap-2 text-sm" style={{ color: C.ink }}>
                          <input
                            type="checkbox"
                            checked={!!adminPerms[sec.id]}
                            onChange={(e) => setAdminPerm(sec.id, e.target.checked)}
                          />
                          {sec.label}
                        </label>
                      ))}
                    </div>
                    <p className="text-xs mt-2" style={{ color: C.accent }}>
                      ℹ️ מנהל מטבח לא יכול לשלוח הזמנה לספק בעצמו - הוא שולח בקשה שתגיע אליך לאישור.
                    </p>
                  </div>
                )}
              </>
            );
          })()}
          <div className="flex gap-2">
            <button onClick={save} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>שמור שינויים</button>
            <button onClick={() => { setForm(null); setEditingId(null); }} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>ביטול</button>
          </div>
        </ShelfTag>
      )}

      <div className="flex flex-col gap-2">
        {users.map((u) => (
          <div key={u.id} className="flex justify-between items-center p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
            <div>
              <div className="font-bold text-sm" style={{ color: C.ink }}>{u.name} {u.role === "manager" ? "👑" : u.role === "supervisor" ? "🧑\u200d🍳" : ""}</div>
              <div className="text-xs font-bold" style={{ color: C.accent }}>{roleLabel(u.role)}</div>
              <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>{u.phone || "ללא טלפון"}</div>
              <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>
                {u.contactEmail || u.loginEmail || "ללא מייל"}
              </div>
              <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>קוד מזהה: {u.id.slice(0, 8)}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => startEdit(u)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
              <button onClick={() => remove(u)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
