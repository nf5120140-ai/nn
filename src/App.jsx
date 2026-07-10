import React, { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

/* ---------- Design tokens ---------- */
const C = {
  ink: "#231F3D",        // deep indigo-ink for text/header
  paper: "#F7F3FF",      // soft lavender-white page background
  kraft: "#FFFFFF",      // card background
  kraftDark: "#E7E0F7",  // card border / subtle divider
  stamp: "#FF5A5F",      // coral-red for shortage/urgent
  mustard: "#FFB347",    // warm orange for tasks/warning
  sage: "#2EC4B6",       // teal for ok/success
  steel: "#7A7592",      // secondary text, muted violet-grey
  accent: "#7C5CFC",     // vivid purple accent
  accent2: "#FF7EB6",    // pink accent
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
  locations: "kitchen-locations",
  dishTypes: "kitchen-dish-types",
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
const MEAL_SLOTS = [
  ["lunch", "צהריים"],
  ["dinner", "ערב"],
];

async function loadKey(key, fallback) {
  try {
    const res = await window.storage.get(key, true);
    if (!res) return fallback;
    return JSON.parse(res.value);
  } catch (e) {
    return fallback;
  }
}
async function saveKey(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), true);
  } catch (e) {
    console.error("storage save failed", key, e);
  }
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayStr = () => new Date().toLocaleDateString("he-IL");

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

    async function startNative() {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new window.BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"],
      });
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
      if (cancelled || !window.Quagga || !quaggaTargetRef.current) return;
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
          if (cancelled) return;
          if (err) { setError("לא ניתן להפעיל את המצלמה עבור הסריקה."); setMode("manual"); return; }
          window.Quagga.start();
        }
      );
      window.Quagga.onDetected((result) => {
        if (result && result.codeResult && result.codeResult.code) {
          finish(result.codeResult.code);
        }
      });
    }

    async function start() {
      if ("BarcodeDetector" in window) {
        try {
          await startNative();
          if (!cancelled) setMode("native");
          return;
        } catch (e) {
          // native camera access failed or detector unsupported for formats - fall through to Quagga
        }
      }
      try {
        setMode("quagga");
        await startQuagga();
      } catch (e) {
        setError("לא ניתן לגשת למצלמה. הזן ברקוד ידנית.");
        setMode("manual");
      }
    }
    start();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
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

const BIOMETRIC_PROMPTED_KEY = "warehouse-app-biometric-prompted";
function hasPromptedBiometric() {
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

function AuthGate({ onAuthed }) {
  const [mode, setMode] = useState(() => (hasExistingAccount() ? "login" : "choose")); // choose | create | join | login
  const [showTerms, setShowTerms] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [orgName, setOrgName] = useState("");
  const [joinOrgId, setJoinOrgId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmNotice, setConfirmNotice] = useState(false);

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
    <div className="min-h-screen flex items-center justify-center wh-body py-8" style={{ background: C.paper }} dir="rtl">
      <style>{FONTS}</style>
      <div className="w-full max-w-xs">
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
            <p className="text-xs" style={{ color: C.steel }}>בקש מהמנהל שלך את קוד/מזהה הארגון (Org ID) שיש לו במסך ניהול.</p>
            <input value={joinOrgId} onChange={(e) => setJoinOrgId(e.target.value)} placeholder="Org ID" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} autoFocus />
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="השם שלך" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון (אופציונלי)" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="מייל" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="סיסמה" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
            <button onClick={doJoin} disabled={busy} className="p-3 rounded-2xl font-bold wh-display" style={{ background: C.ink, color: C.paper }}>
              {busy ? "מצטרף..." : "הצטרף והירשם"}
            </button>
            <button onClick={() => setMode("choose")} className="text-xs" style={{ color: C.steel }}>חזרה</button>
          </ShelfTag>
        )}

        {mode === "login" && (
          <ShelfTag accent={C.ink} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="מייל" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark, direction: "ltr" }} autoFocus />
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="סיסמה" className="p-3 rounded-2xl border" style={{ borderColor: C.kraftDark }} />
            {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
            <button onClick={doLogin} disabled={busy} className="p-3 rounded-2xl font-bold wh-display" style={{ background: C.ink, color: C.paper }}>
              {busy ? "מתחבר..." : "התחבר"}
            </button>
            <button onClick={() => setMode("choose")} className="text-xs underline" style={{ color: C.accent }}>
              אין לי חשבון / רוצה לפתוח ארגון אחר
            </button>
          </ShelfTag>
        )}
        <p className="text-center text-xs mt-6" style={{ color: C.steel }}>
          © כל הזכויות שמורות לנפתלי קמפה · ת.ז. 313****31
        </p>
        <p className="text-center text-xs" style={{ color: C.steel }}>
          המלצות/פניות לפיתוח: 0585120140
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

/* ---------- Main App ---------- */
export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
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
  const [locations, setLocations] = useState([]);
  const [dishTypes, setDishTypes] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [tab, setTab] = useState("tasks");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanResult, setScanResult] = useState(null); // { code, product|null }
  const [toast, setToast] = useState("");
  const [showNotifications, setShowNotifications] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [locked, setLocked] = useState(() => isBiometricEnabled());
  const [biometricPrompt, setBiometricPrompt] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const session = await window.auth.getSession();
        if (session) {
          const profile = await window.auth.getMyProfile();
          if (profile) setAuthProfile(profile);
        }
      } catch (e) {
        console.error(e);
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
        permissions: authProfile.permissions || { inventory: true, order: true, tasks: true },
      });
    } else {
      setCurrentUser(null);
    }
  }, [authProfile]);

  useEffect(() => {
    if (!currentUser) return;
    if (currentUser.role === "manager") return;
    const perms = currentUser.permissions || { inventory: true, order: true, tasks: true };
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
    (async () => {
      const [orgProfiles, p, t, s, n, m, w, r, sl, loc, dt] = await Promise.all([
        window.auth.getOrgProfiles(),
        loadKey(KEYS.products, []),
        loadKey(KEYS.tasks, []),
        loadKey(KEYS.settings, { supplierPhone: "" }),
        loadKey(KEYS.notifications, []),
        loadKey(KEYS.menuItems, []),
        loadKey(KEYS.weeklyMenu, {}),
        loadKey(KEYS.reminders, []),
        loadKey(KEYS.stockLog, []),
        loadKey(KEYS.locations, null),
        loadKey(KEYS.dishTypes, null),
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
      const finalUsers = (orgProfiles || []).map((prof) => ({
        id: prof.id,
        name: prof.display_name || "משתמש",
        phone: prof.phone || "",
        role: prof.role,
        permissions: prof.permissions || { inventory: true, order: true, tasks: true },
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
      setLocations(finalLocations || []);
      setDishTypes(finalDishTypes || []);
      setLoaded(true);
    })();
  }, [currentUser?.id]);

  useEffect(() => {
    if (!loaded || !currentUser || locked) return;
    if (isBiometricEnabled() || hasPromptedBiometric()) return;
    isBiometricSupported().then((supported) => {
      if (supported) setBiometricPrompt(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, currentUser?.id]);

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
    setUsers((cur) => cur.map((u) => (u.id === id ? { ...u, ...fields, name: fields.display_name ?? u.name } : u)));
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
  async function notifyUser(userId, message) {
    const next = [
      ...notifications,
      { id: genId(), userId, message, read: false, createdAt: Date.now() },
    ];
    await persistNotifications(next);
  }

  const lowStock = products.filter((p) => Number(p.quantity) <= Number(p.threshold));
  const myOpenTasks = currentUser
    ? tasks.filter((t) => t.assignedToId === currentUser.id && t.status !== "done")
    : [];
  const myNotifications = currentUser
    ? notifications.filter((n) => n.userId === currentUser.id).sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const unreadCount = myNotifications.filter((n) => !n.read).length;

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
    <div className="min-h-screen flex flex-col wh-body" style={{ background: C.paper }} dir="rtl">
      <style>{FONTS}</style>

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
              {currentUser.name} · {currentUser.role === "manager" ? "מנהל" : "עובד"}
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
                <div
                  key={n.id}
                  className="p-2 rounded-xl text-sm"
                  style={{ background: n.read ? C.paper : "#EFEAFF", color: C.ink }}
                >
                  {n.message}
                </div>
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
        {tab === "inventory" && (
          <InventoryTab
            products={products}
            persistProducts={persistProducts}
            openScanner={() => setScannerOpen(true)}
            scanResult={scanResult}
            clearScanResult={() => setScanResult(null)}
            currentUser={currentUser}
            showToast={showToast}
            isManager={currentUser.role === "manager"}
            logStockChange={logStockChange}
          />
        )}
        {tab === "order" && (
          <OrderTab
            lowStock={lowStock}
            products={products}
            settings={settings}
            persistSettings={persistSettings}
            isManager={currentUser.role === "manager"}
            menuItems={menuItems}
            weeklyMenu={weeklyMenu}
            persistWeeklyMenu={persistWeeklyMenu}
            showToast={showToast}
            dishTypes={dishTypes}
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
          />
        )}
        {tab === "admin" && currentUser.role === "manager" && (
          <AdminTab
            users={users}
            updateUserProfile={updateUserProfile}
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
              <div className="text-xs" style={{ color: "#fff" }}>{currentUser.name} · {currentUser.role === "manager" ? "מנהל" : "עובד"}</div>
            </div>
            <div className="flex flex-col p-3 gap-2 flex-1">
              {(currentUser.role === "manager" || currentUser.permissions?.inventory !== false) && (
                <DrawerItem label="מלאי" active={tab === "inventory"} onClick={() => { setTab("inventory"); setShowMenu(false); }} />
              )}
              {(currentUser.role === "manager" || currentUser.permissions?.order !== false) && (
                <DrawerItem
                  label="הזמנה"
                  active={tab === "order"}
                  onClick={() => { setTab("order"); setShowMenu(false); }}
                  badge={lowStock.length > 0 ? lowStock.length : null}
                  badgeColor={C.stamp}
                />
              )}
              {(currentUser.role === "manager" || currentUser.permissions?.tasks !== false) && (
                <DrawerItem
                  label="משימות"
                  active={tab === "tasks"}
                  onClick={() => { setTab("tasks"); setShowMenu(false); }}
                  badge={myOpenTasks.length > 0 ? myOpenTasks.length : null}
                  badgeColor={C.mustard}
                />
              )}
              {currentUser.role === "manager" && (
                <DrawerItem label="ניהול" active={tab === "admin"} onClick={() => { setTab("admin"); setShowMenu(false); }} />
              )}
            </div>
            {currentUser.role === "manager" && (
              <div className="mx-3 mb-2 p-3 rounded-2xl" style={{ background: C.paper }}>
                <div className="text-xs font-bold mb-1" style={{ color: C.steel }}>לחיבור עובד חדש למסד הזה:</div>
                <div className="text-xs" style={{ color: C.steel }}>
                  שתף איתו את מזהה הארגון (זמין למנהל במסך ניהול ← עובדים) - הוא יזין אותו ב"הצטרף לארגון קיים" בהרשמה הראשונה שלו.
                </div>
              </div>
            )}
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
            <p className="text-center text-xs pb-3" style={{ color: C.steel }}>
              המלצות/פניות לפיתוח: 0585120140
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

function OrderTab({ lowStock, products, settings, persistSettings, isManager, menuItems, weeklyMenu, persistWeeklyMenu, showToast, dishTypes }) {
  const suppliers = settings.suppliers || [];
  const [selectedSupplierId, setSelectedSupplierId] = useState(suppliers[0]?.id || "");
  const [manualPhone, setManualPhone] = useState(settings.supplierPhone || "");
  const [orderMode, setOrderMode] = useState("stock"); // "stock" | "menu" | "week"
  const [qtys, setQtys] = useState(() =>
    Object.fromEntries(lowStock.map((p) => [p.id, Math.max(1, Number(p.threshold) * 2 - Number(p.quantity))]))
  );
  const [selectedMenuIds, setSelectedMenuIds] = useState([]);
  const [portions, setPortions] = useState(1);
  const [weekPortions, setWeekPortions] = useState(1);
  const [menuQtys, setMenuQtys] = useState({});
  const [weekQtys, setWeekQtys] = useState({});
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSupplierFilter, setOrderSupplierFilter] = useState("all");
  const [selectedForOrder, setSelectedForOrder] = useState([]);
  const [openPicker, setOpenPicker] = useState(null);
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

  useEffect(() => {
    setSelectedForOrder((cur) => {
      const lowIds = lowStock.map((p) => p.id);
      const merged = Array.from(new Set([...cur, ...lowIds]));
      return merged;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowStock.length]);

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

  function buildStockMessage() {
    const lines = products
      .filter((p) => selectedForOrder.includes(p.id))
      .map((p) => ({ p, qty: qtys[p.id] ?? 1 }))
      .filter(({ qty }) => Number(qty) > 0)
      .map(({ p, qty }) => `- ${qty} ${p.unit} ${p.name}`);
    return lines.join("\n");
  }

  function resolvedPhone() {
    if (selectedSupplierId === "__manual__") return manualPhone;
    const s = suppliers.find((s) => s.id === selectedSupplierId);
    return s?.phone || manualPhone;
  }

  async function sendOrder() {
    if (selectedForOrder.length === 0) {
      if (showToast) showToast("סמן קודם לפחות מוצר אחד לשליחה");
      return;
    }
    const cleanPhone = resolvedPhone().replace(/\D/g, "");
    const msg = encodeURIComponent(buildStockMessage());
    const url = cleanPhone ? `https://wa.me/${cleanPhone}?text=${msg}` : `https://wa.me/?text=${msg}`;
    window.open(url, "_blank");
  }

  // Group a set of rows (product + qty) by the product's assigned supplier.
  // Rows for products with no assigned supplier fall under "__unassigned__".
  function groupBySupplier(rows, qtyStore) {
    const groups = {};
    rows.forEach(({ product, deficit }) => {
      const qty = getQty(qtyStore, product, deficit);
      if (Number(qty) <= 0) return;
      const key = product.supplierId || "__unassigned__";
      if (!groups[key]) groups[key] = [];
      groups[key].push({ product, qty });
    });
    return groups;
  }

  function sendGroupOrder(items, title, supplierId) {
    const lines = items.map(({ product, qty }) => `- ${qty} ${product.unit} ${product.name}`);
    const msg = encodeURIComponent(lines.join("\n"));
    let phone = "";
    if (supplierId && supplierId !== "__unassigned__") {
      phone = suppliers.find((s) => s.id === supplierId)?.phone || "";
    } else {
      phone = resolvedPhone();
    }
    const cleanPhone = phone.replace(/\D/g, "");
    const url = cleanPhone ? `https://wa.me/${cleanPhone}?text=${msg}` : `https://wa.me/?text=${msg}`;
    window.open(url, "_blank");
  }

  function printWeeklyMenu() {
    const rows = WEEK_DAYS.map(([dayKey, dayLabel]) => {
      const cells = MEAL_SLOTS.map(([slotKey]) => {
        const names = (dishTypes || []).map((dt) => {
          const id = weeklyMenu[dayKey]?.[slotKey]?.[dt.id];
          const m = menuItems.find((mi) => mi.id === id);
          return m ? m.name : null;
        }).filter(Boolean);
        return names.length > 0 ? names.join("<br/>") : "—";
      });
      return { dayLabel, cells };
    });
    const headerCells = MEAL_SLOTS.map(([, label]) => `<th>${label}</th>`).join("");
    const bodyRows = rows
      .map((r) => `<tr><td class="daycell">${r.dayLabel}</td>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("");
    const html = `
      <!doctype html>
      <html lang="he" dir="rtl">
        <head>
          <meta charset="UTF-8" />
          <title>תפריט שבועי</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; }
            h1 { text-align: center; font-size: 20px; margin-bottom: 16px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #333; padding: 10px; text-align: center; font-size: 14px; }
            th { background: #EFEAFF; }
            .daycell { font-weight: bold; background: #F7F3FF; }
          </style>
        </head>
        <body>
          <h1>תפריט שבועי — ${todayStr()}</h1>
          <table>
            <thead><tr><th></th>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
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

      <div className="mb-4">
        <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שלח הזמנה לספק</label>
        <select
          value={selectedSupplierId}
          onChange={(e) => setSelectedSupplierId(e.target.value)}
          className="p-2 rounded-2xl border w-full"
          style={{ borderColor: C.kraftDark }}
        >
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
          <option value="__manual__">מספר אחר (הזנה ידנית)</option>
        </select>
        {(selectedSupplierId === "__manual__" || suppliers.length === 0) && (
          <input
            value={manualPhone}
            onChange={(e) => setManualPhone(e.target.value)}
            placeholder="972501234567"
            className="mt-2 p-2 rounded-2xl border w-full"
            style={{ borderColor: C.kraftDark, direction: "ltr" }}
          />
        )}
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
            <button onClick={sendOrder} className="w-full py-3 rounded-2xl wh-display font-bold" style={{ background: "#25D366", color: "#fff" }}>
              שלח הזמנה בוואטסאפ
            </button>
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
                <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>מה חסר לפי החישוב (אפשר לערוך כמות):</div>
                <div className="flex flex-col gap-2 mb-4">
                  {menuNeeds.map((n) => {
                    const supplierName = n.product.supplierId
                      ? suppliers.find((s) => s.id === n.product.supplierId)?.name
                      : null;
                    return (
                      <ShelfTag key={n.product.id} accent={n.deficit > 0 ? C.stamp : C.sage}>
                        <div className="flex justify-between items-center text-sm">
                          <div>
                            <div style={{ color: C.ink }} className="font-bold">{n.product.name}</div>
                            <div style={{ color: C.steel }} className="text-xs">
                              צריך {n.totalNeeded} · יש {n.product.quantity}
                              {supplierName && ` · ספק: ${supplierName}`}
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
                {Object.entries(groupBySupplier(menuNeeds, menuQtys)).map(([supplierId, items]) => {
                  const supplierName = supplierId === "__unassigned__" ? "ספק כללי" : suppliers.find((s) => s.id === supplierId)?.name || "ספק";
                  return (
                    <button
                      key={supplierId}
                      onClick={() => sendGroupOrder(items, "📋 הזמנה לפי תפריט", supplierId)}
                      className="w-full py-3 mb-2 rounded-2xl wh-display font-bold"
                      style={{ background: "#25D366", color: "#fff" }}
                    >
                      שלח ל{supplierName} ({items.length} מוצרים)
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
              <button
                onClick={printWeeklyMenu}
                className="w-full py-3 rounded-2xl text-sm font-bold"
                style={{ background: C.accent, color: "#fff" }}
              >
                🖨️ הדפס תפריט שבועי
              </button>
            </div>

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
                <div className="wh-display font-bold text-sm mb-2" style={{ color: C.ink }}>מה חסר לכל השבוע (אפשר לערוך כמות):</div>
                <div className="flex flex-col gap-2 mb-4">
                  {weekNeeds.rows.map((n) => {
                    const supplierName = n.product.supplierId
                      ? suppliers.find((s) => s.id === n.product.supplierId)?.name
                      : null;
                    return (
                      <ShelfTag key={n.product.id} accent={n.deficit > 0 ? C.stamp : C.sage}>
                        <div className="flex justify-between items-center text-sm">
                          <div>
                            <div style={{ color: C.ink }} className="font-bold">{n.product.name}</div>
                            <div style={{ color: C.steel }} className="text-xs">
                              צריך {n.totalNeeded} · יש {n.product.quantity}
                              {supplierName && ` · ספק: ${supplierName}`}
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
                {Object.entries(groupBySupplier(weekNeeds.rows, weekQtys)).map(([supplierId, items]) => {
                  const supplierName = supplierId === "__unassigned__" ? "ספק כללי" : suppliers.find((s) => s.id === supplierId)?.name || "ספק";
                  return (
                    <button
                      key={supplierId}
                      onClick={() => sendGroupOrder(items, "📅 הזמנה לפי תפריט שבועי", supplierId)}
                      className="w-full py-3 mb-2 rounded-2xl wh-display font-bold"
                      style={{ background: "#25D366", color: "#fff" }}
                    >
                      שלח ל{supplierName} ({items.length} מוצרים)
                    </button>
                  );
                })}
              </>
            )}
          </>
        )
      )}
    </div>
  );
}

/* ---------- Tasks Tab ---------- */
function TasksTab({ tasks, persistTasks, users, currentUser, showToast, notifyUser, locations }) {
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState("open");
  const [employeeFilter, setEmployeeFilter] = useState("all");

  const visible = tasks
    .filter((t) => (filter === "all" ? true : filter === "open" ? t.status !== "done" : t.status === "done"))
    .filter((t) => (employeeFilter === "all" ? true : t.assignedToId === employeeFilter))
    .sort((a, b) => b.createdAt - a.createdAt);

  async function updateStatus(task, status) {
    const next = tasks.map((t) => (t.id === task.id ? { ...t, status } : t));
    await persistTasks(next);
  }

  async function reassign(task, assignedToId) {
    const next = tasks.map((t) => (t.id === task.id ? { ...t, assignedToId } : t));
    await persistTasks(next);
    if (notifyUser && assignedToId !== task.assignedToId) {
      notifyUser(assignedToId, `שויכה אליך משימה: ${task.title}`);
    }
  }

  async function deleteTask(task) {
    const next = tasks.filter((t) => t.id !== task.id);
    await persistTasks(next);
    showToast("המשימה נמחקה");
  }

  async function addTask(newTask) {
    const created = { ...newTask, id: genId(), createdAt: Date.now(), createdBy: currentUser.name, status: "open" };
    const next = [...tasks, created];
    await persistTasks(next);
    setShowNew(false);
    showToast("המשימה נוצרה");
    if (notifyUser) notifyUser(newTask.assignedToId, `משימה חדשה: ${newTask.title}`);
  }

  function notifyWhatsapp(task) {
    const user = users.find((u) => u.id === task.assignedToId);
    if (!user || !user.phone) {
      showToast("לא הוגדר מספר טלפון לעובד זה");
      return;
    }
    const priorityLabel = { low: "נמוכה", normal: "רגילה", urgent: "דחופה" }[task.priority] || "רגילה";
    const msg = encodeURIComponent(
      `🛠️ משימה/תקלה חדשה\nכותרת: ${task.title}${task.location ? `\nמקום: ${task.location}` : ""}\nפירוט: ${task.description || "—"}\nעדיפות: ${priorityLabel}`
    );
    window.open(`https://wa.me/${user.phone.replace(/\D/g, "")}?text=${msg}`, "_blank");
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
      </div>

      {showNew && (
        <NewTaskForm users={users} onSubmit={addTask} onCancel={() => setShowNew(false)} locations={locations} />
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
                  <div className="wh-display font-bold" style={{ color: C.ink }}>{t.title}</div>
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
                  <div className="text-xs mt-2 flex items-center gap-2">
                    <span style={{ color: C.steel }}>שויך ל:</span>
                    <select
                      value={t.assignedToId || ""}
                      onChange={(e) => reassign(t, e.target.value)}
                      className="text-xs p-1 rounded-2xl border"
                      style={{ borderColor: C.kraftDark, background: "#fff", color: C.ink }}
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                    <span style={{ color: C.steel }}>· נוצר ע"י {t.createdBy}</span>
                  </div>
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
                <button onClick={() => notifyWhatsapp(t)} className="px-3 py-1 rounded-2xl text-sm font-bold" style={{ background: "#25D366", color: "#fff" }}>
                  עדכן בוואטסאפ
                </button>
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

function NewTaskForm({ users, onSubmit, onCancel, locations }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedToId, setAssignedToId] = useState(users[0]?.id || "");
  const [priority, setPriority] = useState("normal");
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
            onSubmit({ title, description, assignedToId, priority, location: locationLabel, locationId, imageData });
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
function AdminTab({ users, updateUserProfile, currentUser, products, persistProducts, settings, persistSettings, showToast, menuItems, persistMenuItems, weeklyMenu, persistWeeklyMenu, reminders, persistReminders, stockLog, locations, persistLocations, dishTypes, persistDishTypes }) {
  const [section, setSection] = useState("products");

  return (
    <div>
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {[["products", "מוצרים"], ["users", "עובדים"], ["menu", "תפריט"], ["dishtypes", "סוגי מנות"], ["locations", "מקומות"], ["reminders", "תזכורות"], ["analytics", "ניתוח"], ["settings", "הגדרות"]].map(([val, label]) => (
          <button
            key={val}
            onClick={() => setSection(val)}
            className="px-3 py-1 rounded-2xl text-sm font-bold whitespace-nowrap"
            style={{ background: section === val ? C.ink : C.kraft, color: section === val ? C.paper : C.ink }}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "products" && (
        <ProductsAdmin products={products} persistProducts={persistProducts} showToast={showToast} settings={settings} persistSettings={persistSettings} />
      )}
      {section === "users" && (
        <UsersAdmin users={users} updateUserProfile={updateUserProfile} showToast={showToast} currentUser={currentUser} />
      )}
      {section === "menu" && (
        <MenuAdmin menuItems={menuItems} persistMenuItems={persistMenuItems} products={products} showToast={showToast} weeklyMenu={weeklyMenu} persistWeeklyMenu={persistWeeklyMenu} dishTypes={dishTypes} />
      )}
      {section === "dishtypes" && (
        <DishTypesAdmin dishTypes={dishTypes} persistDishTypes={persistDishTypes} showToast={showToast} />
      )}
      {section === "locations" && (
        <LocationsAdmin locations={locations} persistLocations={persistLocations} showToast={showToast} />
      )}
      {section === "reminders" && (
        <RemindersAdmin reminders={reminders} persistReminders={persistReminders} products={products} users={users} showToast={showToast} />
      )}
      {section === "analytics" && (
        <AnalyticsAdmin products={products} stockLog={stockLog} />
      )}
      {section === "settings" && (
        <SuppliersAdmin settings={settings} persistSettings={persistSettings} showToast={showToast} />
      )}
    </div>
  );
}

function AnalyticsAdmin({ products, stockLog }) {
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
    XLSX.utils.book_append_sheet(wb, sheet, "מקומות");
    XLSX.writeFile(wb, "תבנית-מקומות.xlsx");
  }

  function exportLocations() {
    const rows = locations.map((l) => ({ "שם מקום/חדר": l.name, "קבוצה/אזור": l.group || "" }));
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "שם מקום/חדר": "", "קבוצה/אזור": "" }]);
    sheet["!cols"] = [{ wch: 26 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "מקומות");
    XLSX.writeFile(wb, "מקומות.xlsx");
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

function SuppliersAdmin({ settings, persistSettings, showToast }) {
  const suppliers = settings.suppliers || [];
  const empty = { name: "", phone: "" };
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
      const contacts = await navigator.contacts.select(["name", "tel"], { multiple: true });
      if (!contacts || contacts.length === 0) {
        showToast("לא נבחרו אנשי קשר");
        return;
      }
      const newSuppliers = contacts
        .map((c) => ({
          id: genId(),
          name: c.name?.[0] || "ללא שם",
          phone: normalizePhone(c.tel?.[0] || ""),
        }))
        .filter((s) => s.phone);

      if (newSuppliers.length === 0) {
        showToast("לאנשי הקשר שנבחרו אין מספרי טלפון שמורים");
        return;
      }

      await persistSettings({ ...settings, suppliers: [...suppliers, ...newSuppliers] });
      showToast(`נוספו ${newSuppliers.length} ספקים מאנשי הקשר`);
    } catch (err) {
      console.error(err);
      showToast("שגיאה בייבוא אנשי קשר: " + (err?.message || "לא ידועה"));
    }
  }

  async function save() {
    if (!form.name.trim() || !form.phone.trim()) return showToast("יש להזין שם וטלפון");
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
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>טלפון וואטסאפ (972501234567)</label>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
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
              <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>{s.phone}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setForm(s); setEditingId(s.id); }} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
              <button onClick={() => remove(s.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
            </div>
          </div>
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
  const empty = { name: "", category: "בשרי", dishType: "", ingredients: [] };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const [ingProductId, setIngProductId] = useState(products[0]?.id || "");
  const [ingQty, setIngQty] = useState(1);
  const [assignDay, setAssignDay] = useState("");
  const [assignMeal, setAssignMeal] = useState("lunch");

  function addIngredient() {
    if (!ingProductId) return;
    const product = products.find((p) => p.id === ingProductId);
    if (!product) return;
    if (form.ingredients.some((i) => i.productId === ingProductId)) {
      return showToast("המוצר כבר ברשימה");
    }
    setForm({ ...form, ingredients: [...form.ingredients, { productId: ingProductId, qty: Number(ingQty) }] });
  }

  function removeIngredient(productId) {
    setForm({ ...form, ingredients: form.ingredients.filter((i) => i.productId !== productId) });
  }

  async function save() {
    if (!form.name.trim()) return showToast("יש להזין שם מנה");
    if (form.ingredients.length === 0) return showToast("הוסף לפחות מרכיב אחד");
    let next;
    let savedId = editingId;
    if (editingId) {
      next = menuItems.map((m) => (m.id === editingId ? { ...form, id: editingId } : m));
    } else {
      savedId = genId();
      next = [...menuItems, { ...form, id: savedId }];
    }
    await persistMenuItems(next);

    if (assignDay && persistWeeklyMenu) {
      const dishType = form.dishType || dishTypes[0]?.id;
      if (!dishType) return;
      const daySlots = weeklyMenu[assignDay] || {};
      const slotTypes = daySlots[assignMeal] || {};
      const nextWeekly = {
        ...weeklyMenu,
        [assignDay]: { ...daySlots, [assignMeal]: { ...slotTypes, [dishType]: savedId } },
      };
      await persistWeeklyMenu(nextWeekly);
    }

    setForm(empty);
    setEditingId(null);
    setAssignDay("");
    showToast(assignDay ? "המנה נשמרה ושובצה ללוח השבועי" : "המנה נשמרה");
  }

  async function remove(id) {
    await persistMenuItems(menuItems.filter((m) => m.id !== id));
  }

  return (
    <div>
      <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>
          {editingId ? "עריכת מנה" : "הוספת מנה לתפריט"}
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שם המנה</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>כשרות</label>
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="בשרי">בשרי</option>
            <option value="חלבי">חלבי</option>
            <option value="פרווה">פרווה</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>סוג המנה (לשיבוץ בלוח השבועי)</label>
          {dishTypes.length === 0 ? (
            <p className="text-xs" style={{ color: C.steel }}>אין עדיין קטגוריות מוגדרות - הוסף במסך ניהול ← סוגי מנות.</p>
          ) : (
            <select value={form.dishType || dishTypes[0]?.id || ""} onChange={(e) => setForm({ ...form, dishType: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
              {dishTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>

        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מרכיבים (מהמלאי הקיים)</label>
          <div className="flex gap-2 mb-2">
            <select value={ingProductId} onChange={(e) => setIngProductId(e.target.value)} className="flex-1 p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="number" value={ingQty} onChange={(e) => setIngQty(e.target.value)} className="w-16 p-2 rounded-2xl border text-center" style={{ borderColor: C.kraftDark }} />
            <button onClick={addIngredient} className="px-3 rounded-2xl font-bold" style={{ background: C.sage, color: "#fff" }}>+</button>
          </div>
          <div className="flex flex-col gap-1">
            {form.ingredients.map((ing) => {
              const p = products.find((pp) => pp.id === ing.productId);
              return (
                <div key={ing.productId} className="flex justify-between items-center text-sm p-1.5 rounded-xl" style={{ background: C.paper }}>
                  <span>{p ? p.name : "מוצר לא ידוע"} — {ing.qty} {p?.unit}</span>
                  <button onClick={() => removeIngredient(ing.productId)} className="text-xs px-2 rounded-xl" style={{ background: C.stamp, color: "#fff" }}>✕</button>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שיבוץ ללוח השבועי (אופציונלי)</label>
          <div className="flex gap-2">
            <select value={assignDay} onChange={(e) => setAssignDay(e.target.value)} className="flex-1 p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
              <option value="">— לא לשבץ עכשיו —</option>
              {WEEK_DAYS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
            </select>
            <select value={assignMeal} onChange={(e) => setAssignMeal(e.target.value)} className="flex-1 p-2 rounded-2xl border" style={{ borderColor: C.kraftDark }}>
              {MEAL_SLOTS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
            </select>
          </div>
          {assignDay && (
            <p className="text-xs mt-1" style={{ color: C.steel }}>
              המנה תשובץ כ"{dishTypes.find((d) => d.id === form.dishType)?.name || ""}" ב{WEEK_DAYS.find(([v]) => v === assignDay)?.[1]} - {MEAL_SLOTS.find(([v]) => v === assignMeal)?.[1]}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.ink, color: C.paper }}>
            {editingId ? "שמור שינויים" : "הוסף מנה"}
          </button>
          {editingId && (
            <button onClick={() => { setForm(empty); setEditingId(null); }} className="flex-1 py-2 rounded-2xl font-bold" style={{ background: C.kraft, color: C.ink }}>
              ביטול
            </button>
          )}
        </div>
      </ShelfTag>

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
                <button onClick={() => { setForm(m); setEditingId(m.id); }} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
                <button onClick={() => remove(m.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const PRODUCT_CATEGORIES = [
  "יבשים",
  "מוצרי ניקיון",
  "חד פעמי",
  "קפואים",
  "קירור / ירקות",
  "אחר",
];

function ProductsAdmin({ products, persistProducts, showToast, settings, persistSettings }) {
  const suppliers = settings?.suppliers || [];
  const empty = { name: "", barcode: "", quantity: 0, threshold: 1, price: 0, unit: "יח׳", unitsPerCarton: 0, category: "", supplierId: "", imageData: null };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [adminSearch, setAdminSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkThreshold, setBulkThreshold] = useState("");
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
    XLSX.utils.book_append_sheet(wb, sheet, "מוצרים");
    XLSX.writeFile(wb, "מוצרים.xlsx");
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
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>קטגוריה</label>
          <select value={form.category || ""} onChange={(e) => setForm({ ...form, category: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="">ללא קטגוריה</option>
            {PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
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

      {selectedIds.length > 0 && (
        <ShelfTag accent={C.accent} style={{ marginBottom: 16 }}>
          <div className="text-sm font-bold mb-2" style={{ color: C.ink }}>
            {selectedIds.length} מוצרים נבחרו - עדכן להם סף מינימום אחד
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              value={bulkThreshold}
              onChange={(e) => setBulkThreshold(e.target.value)}
              placeholder="סף מינימום חדש"
              className="flex-1 p-2 rounded-2xl border text-center"
              style={{ borderColor: C.kraftDark }}
            />
            <button onClick={applyBulkThreshold} className="px-4 rounded-2xl font-bold text-sm" style={{ background: C.sage, color: "#fff" }}>
              עדכן
            </button>
            <button onClick={() => setSelectedIds([])} className="px-4 rounded-2xl font-bold text-sm" style={{ background: C.kraft, color: C.ink }}>
              נקה בחירה
            </button>
          </div>
        </ShelfTag>
      )}

      <div className="flex flex-col gap-4">
        {Object.entries(
          products
            .filter((p) => !adminSearch || p.name.includes(adminSearch) || (p.barcode || "").includes(adminSearch))
            .reduce((acc, p) => {
              const cat = p.category || "ללא קטגוריה";
              (acc[cat] = acc[cat] || []).push(p);
              return acc;
            }, {})
        ).map(([cat, items]) => (
          <div key={cat}>
            <div className="wh-display font-bold text-sm mb-2" style={{ color: C.steel }}>{cat} ({items.length})</div>
            <div className="flex flex-col gap-2">
              {items.map((p) => (
                <div key={p.id} className="flex justify-between items-center p-3 rounded-2xl" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(p.id)}
                      onChange={() => toggleSelect(p.id)}
                    />
                    {p.imageData && <img src={p.imageData} alt="" className="rounded-xl" style={{ width: 40, height: 40, objectFit: "cover" }} />}
                    <div>
                      <div className="font-bold text-sm" style={{ color: C.ink }}>{p.name}</div>
                      <div className="text-xs" style={{ color: C.steel }}>₪{Number(p.price).toFixed(2)} · {p.quantity} {p.unit} · סף: {p.threshold}</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => startEdit(p)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
                    <button onClick={() => remove(p.id)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
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

function UsersAdmin({ users, updateUserProfile, showToast, currentUser }) {
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(null);
  const [copied, setCopied] = useState(false);

  function startEdit(u) {
    setForm({ ...u });
    setEditingId(u.id);
  }

  async function save() {
    await updateUserProfile(editingId, {
      display_name: form.name,
      phone: form.phone,
      role: form.role,
      permissions: form.permissions,
    });
    setEditingId(null);
    setForm(null);
    showToast("העובד עודכן");
  }

  function copyOrgId() {
    navigator.clipboard?.writeText(currentUser.orgId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div>
      <ShelfTag accent={C.accent} style={{ marginBottom: 16 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>הזמנת עובד חדש</div>
        <p className="text-xs mb-2" style={{ color: C.steel }}>
          עובדים לא נוצרים כאן - כל אחד נרשם בעצמו במסך הכניסה עם "הצטרף לארגון קיים" ומזין את מזהה הארגון הזה:
        </p>
        <div className="p-2 rounded-xl text-xs mb-2" style={{ background: C.ink, color: "#fff", direction: "ltr", wordBreak: "break-all", fontFamily: "monospace" }}>
          {currentUser.orgId}
        </div>
        <button onClick={copyOrgId} className="w-full py-1.5 rounded-xl text-xs font-bold" style={{ background: C.paper, color: C.ink }}>
          {copied ? "הועתק ✓" : "העתק מזהה ארגון"}
        </button>
      </ShelfTag>

      {editingId && form && (
        <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>עריכת עובד</div>
          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שם</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>טלפון (לוואטסאפ)</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>תפקיד</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="p-2 rounded-2xl border w-full" style={{ borderColor: C.kraftDark }}>
              <option value="staff">עובד</option>
              <option value="manager">מנהל</option>
            </select>
          </div>
          {form.role === "staff" && (
            <div>
              <label className="text-xs font-bold block mb-2" style={{ color: C.steel }}>מה העובד יראה באפליקציה</label>
              <div className="flex flex-col gap-2">
                {[
                  ["inventory", "מלאי"],
                  ["order", "הזמנה"],
                  ["tasks", "משימות"],
                ].map(([key, label]) => {
                  const perms = form.permissions || { inventory: true, order: true, tasks: true };
                  return (
                    <label key={key} className="flex items-center gap-2 text-sm" style={{ color: C.ink }}>
                      <input
                        type="checkbox"
                        checked={perms[key] !== false}
                        onChange={(e) => setForm({ ...form, permissions: { ...perms, [key]: e.target.checked } })}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
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
              <div className="font-bold text-sm" style={{ color: C.ink }}>{u.name} {u.role === "manager" && "👑"}</div>
              <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>{u.phone || "ללא טלפון"}</div>
            </div>
            <button onClick={() => startEdit(u)} className="text-xs px-2 py-1 rounded-2xl" style={{ background: C.kraft }}>ערוך</button>
          </div>
        ))}
      </div>
    </div>
  );
}
