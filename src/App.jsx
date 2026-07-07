import React, { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

/* ---------- Design tokens ---------- */
const C = {
  ink: "#1F2A24",       // near-black warehouse ink
  paper: "#F5F1E6",     // page background, warm paper
  kraft: "#EAE0CC",     // card background, kraft label
  kraftDark: "#DCCFB0",
  stamp: "#AF3B32",     // shortage / urgent stamp red
  mustard: "#C99A2E",   // tasks / warning
  sage: "#5E7F5E",      // ok / success
  steel: "#59645F",     // secondary text
};

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
};

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
const LOCATIONS = [
  {
    group: "בניין ישן - קומה 1",
    rooms: [...range(101, 113), "שירותים קומה 1", "מקלחות קומה 1"],
  },
  {
    group: "בניין ישן - קומה 2",
    rooms: [...range(201, 212), "שירותים קומה 2", "מקלחות קומה 2"],
  },
  {
    group: "בניין ישן - קומה 3",
    rooms: [...range(301, 313), "שירותים קומה 3", "מקלחות קומה 3"],
  },
  {
    group: "בניין ישן - קומה 4",
    rooms: [...range(401, 412), "שירותים קומה 4", "מקלחות קומה 4"],
  },
  { group: "בניין חדש - קומה 1", rooms: range(501, 509) },
  { group: "בניין חדש - קומה 2", rooms: range(601, 609) },
  { group: "בניין חדש - קומה 3", rooms: ["מרפסת", "חדר כביסה"] },
  {
    group: "דירות רבנים",
    rooms: ["דירת רבנים חדשה - ימין", "דירת רבנים חדשה - שמאל", "דירת רבנים ישנה"],
  },
  {
    group: "בית מדרש",
    rooms: [
      "בית מדרש",
      ...range(1, 5).map((n) => `שירותים בית מדרש - ימין ${n}`),
      ...range(1, 5).map((n) => `שירותים בית מדרש - שמאל ${n}`),
    ],
  },
  {
    group: "מטבחים וחדרי אוכל",
    rooms: ["מטבח בשרי", "מטבח חלבי", "חדר אוכל גדול", "חדר אוכל רבנים", "חדר אוכל קטן"],
  },
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

/* ---------- Shelf-tag card (signature element) ---------- */
function ShelfTag({ children, accent = C.steel, style = {} }) {
  return (
    <div
      className="relative wh-body"
      style={{
        background: C.kraft,
        borderRadius: "4px 14px 4px 14px",
        border: `1px solid ${C.kraftDark}`,
        boxShadow: "2px 3px 0 rgba(31,42,36,0.12)",
        padding: "14px 16px 12px 16px",
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: C.paper,
          border: `1px solid ${C.kraftDark}`,
        }}
      />
      <div style={{ borderTop: `3px double ${accent}`, position: "absolute", bottom: 0, left: 14, right: 14 }} />
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
        <button onClick={onClose} className="px-3 py-1 rounded" style={{ background: C.paper, color: C.ink }}>
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
            className="w-full max-w-xs p-3 rounded text-lg text-center"
            style={{ direction: "ltr" }}
            autoFocus
          />
          <button
            onClick={() => manual.trim() && finish(manual.trim())}
            className="px-6 py-2 rounded font-bold wh-display"
            style={{ background: C.mustard, color: C.ink }}
          >
            אישור
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Login ---------- */
function Login({ users, onLogin, onFirstRun }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  function submit() {
    const u = users.find((u) => u.name === name.trim() && u.password === password);
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
          מחסן המטבח
        </h1>
        <p className="text-center text-sm mb-6" style={{ color: C.steel }}>
          כניסה למערכת ניהול המלאי
        </p>
        <ShelfTag accent={C.sage} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="שם משתמש"
            className="p-3 rounded border"
            style={{ borderColor: C.kraftDark, background: C.paper }}
            autoFocus
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            type="password"
            placeholder="סיסמה"
            className="p-3 rounded border"
            style={{ borderColor: C.kraftDark, background: C.paper }}
          />
          {err && <p style={{ color: C.stamp }} className="text-sm">{err}</p>}
          <button
            type="button"
            onClick={submit}
            className="p-3 rounded font-bold wh-display"
            style={{ background: C.ink, color: C.paper, cursor: "pointer" }}
          >
            כניסה
          </button>
        </ShelfTag>
        {onFirstRun && (
          <p className="text-xs text-center mt-4" style={{ color: C.steel }}>
            משתמש ברירת מחדל: <b>מנהל</b> / סיסמה <b>1234</b> (ניתן לשנות בהגדרות לאחר הכניסה)
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------- Main App ---------- */
export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [settings, setSettings] = useState({ supplierPhone: "" });
  const [currentUser, setCurrentUser] = useState(null);
  const [tab, setTab] = useState("inventory");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanResult, setScanResult] = useState(null); // { code, product|null }
  const [toast, setToast] = useState("");

  useEffect(() => {
    (async () => {
      const [u, p, t, s] = await Promise.all([
        loadKey(KEYS.users, []),
        loadKey(KEYS.products, []),
        loadKey(KEYS.tasks, []),
        loadKey(KEYS.settings, { supplierPhone: "" }),
      ]);
      let finalUsers = u;
      if (!u || u.length === 0) {
        finalUsers = [{ id: genId(), name: "מנהל", password: "1234", role: "manager", phone: "" }];
        await saveKey(KEYS.users, finalUsers);
      }
      setUsers(finalUsers);
      setProducts(p || []);
      setTasks(t || []);
      setSettings(s || { supplierPhone: "" });
      setLoaded(true);
    })();
  }, []);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }

  async function persistProducts(next) {
    setProducts(next);
    await saveKey(KEYS.products, next);
  }
  async function persistUsers(next) {
    setUsers(next);
    await saveKey(KEYS.users, next);
  }
  async function persistTasks(next) {
    setTasks(next);
    await saveKey(KEYS.tasks, next);
  }
  async function persistSettings(next) {
    setSettings(next);
    await saveKey(KEYS.settings, next);
  }

  const lowStock = products.filter((p) => Number(p.quantity) <= Number(p.threshold));
  const myOpenTasks = currentUser
    ? tasks.filter((t) => t.assignedToId === currentUser.id && t.status !== "done")
    : [];

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: C.paper }}>
        <p className="wh-body" style={{ color: C.steel }}>טוען...</p>
      </div>
    );
  }

  if (!currentUser) {
    return <Login users={users} onLogin={setCurrentUser} onFirstRun={users.length === 1} />;
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
      <div className="flex items-center justify-between px-4 py-3" style={{ background: C.ink }}>
        <div>
          <div className="wh-display font-black text-lg" style={{ color: C.paper }}>מחסן המטבח</div>
          <div className="text-xs" style={{ color: C.kraft }}>
            {currentUser.name} · {currentUser.role === "manager" ? "מנהל" : "עובד"}
          </div>
        </div>
        <button
          onClick={() => setCurrentUser(null)}
          className="text-xs px-3 py-1 rounded"
          style={{ background: C.kraft, color: C.ink }}
        >
          יציאה
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className="fixed top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded wh-body text-sm font-medium"
          style={{ background: C.ink, color: C.paper }}
        >
          {toast}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24">
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
          />
        )}
        {tab === "order" && (
          <OrderTab
            lowStock={lowStock}
            settings={settings}
            persistSettings={persistSettings}
            isManager={currentUser.role === "manager"}
          />
        )}
        {tab === "tasks" && (
          <TasksTab
            tasks={tasks}
            persistTasks={persistTasks}
            users={users}
            currentUser={currentUser}
            showToast={showToast}
          />
        )}
        {tab === "admin" && currentUser.role === "manager" && (
          <AdminTab
            users={users}
            persistUsers={persistUsers}
            products={products}
            persistProducts={persistProducts}
            settings={settings}
            persistSettings={persistSettings}
            showToast={showToast}
          />
        )}
      </div>

      {/* Bottom tab bar */}
      <div
        className="fixed bottom-0 left-0 right-0 flex justify-around items-stretch"
        style={{ background: C.ink, borderTop: `1px solid ${C.steel}` }}
      >
        <TabButton label="מלאי" active={tab === "inventory"} onClick={() => setTab("inventory")} />
        <TabButton
          label="הזמנה"
          active={tab === "order"}
          onClick={() => setTab("order")}
          badge={lowStock.length > 0 ? lowStock.length : null}
          badgeColor={C.stamp}
        />
        <TabButton
          label="משימות"
          active={tab === "tasks"}
          onClick={() => setTab("tasks")}
          badge={myOpenTasks.length > 0 ? myOpenTasks.length : null}
          badgeColor={C.mustard}
        />
        {currentUser.role === "manager" && (
          <TabButton label="ניהול" active={tab === "admin"} onClick={() => setTab("admin")} />
        )}
      </div>

      {scannerOpen && (
        <BarcodeScanner onDetected={handleScanDetected} onClose={() => setScannerOpen(false)} />
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

/* ---------- Inventory Tab ---------- */
function InventoryTab({ products, persistProducts, openScanner, scanResult, clearScanResult, currentUser, showToast, isManager }) {
  const [search, setSearch] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const [viewMode, setViewMode] = useState("category"); // "category" | "name"
  const filtered = products.filter((p) => p.name.includes(search) || p.barcode.includes(search));

  async function adjustQty(product, delta) {
    const next = products.map((p) =>
      p.id === product.id ? { ...p, quantity: Math.max(0, Number(p.quantity) + delta) } : p
    );
    await persistProducts(next);
    showToast(`${product.name}: ${delta > 0 ? "+" : ""}${delta} (${currentUser.name})`);
  }

  async function setQty(product, newQty) {
    const next = products.map((p) => (p.id === product.id ? { ...p, quantity: newQty } : p));
    await persistProducts(next);
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
        className="w-full py-2 mb-4 rounded font-bold text-sm wh-display"
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
          className="flex-1 p-3 rounded border"
          style={{ borderColor: C.kraftDark, background: "#fff" }}
        />
        <button
          onClick={openScanner}
          className="px-4 rounded wh-display font-bold"
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

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setViewMode("category")}
          className="flex-1 py-2 rounded text-sm font-bold"
          style={{ background: viewMode === "category" ? C.ink : C.kraft, color: viewMode === "category" ? C.paper : C.ink }}
        >
          לפי קטגוריה
        </button>
        <button
          onClick={() => setViewMode("name")}
          className="flex-1 py-2 rounded text-sm font-bold"
          style={{ background: viewMode === "name" ? C.ink : C.kraft, color: viewMode === "name" ? C.paper : C.ink }}
        >
          לפי שם (רשימה)
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {filtered.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: C.steel }}>
            אין מוצרים להצגה. {isManager ? "הוסף מוצרים במסך ניהול." : ""}
          </p>
        )}
        {viewMode === "name" ? (
          <div className="flex flex-col gap-3">
            {[...filtered].sort((a, b) => a.name.localeCompare(b.name, "he")).map((p) => (
              <ProductCard key={p.id} p={p} onSetQty={setQty} />
            ))}
          </div>
        ) : (
          Object.entries(
            filtered.reduce((acc, p) => {
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
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-20 text-center p-2 rounded border"
          style={{ borderColor: C.kraftDark }}
        />
        <button
          onClick={() => onSetQty(p, Math.max(0, Number(value)))}
          disabled={!changed}
          className="flex-1 py-2 rounded font-bold"
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
        <button onClick={onClose} className="w-full py-2 rounded font-bold" style={{ background: C.ink, color: C.paper }}>
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
        <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="px-3 py-1 rounded" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>−</button>
        <input
          type="number"
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
          className="w-16 text-center p-1 rounded border"
          style={{ borderColor: C.kraftDark }}
        />
        <button onClick={() => setQty((q) => q + 1)} className="px-3 py-1 rounded" style={{ background: C.paper, border: `1px solid ${C.kraftDark}` }}>+</button>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => { onAdjust(product, -qty); onClose(); }}
          className="flex-1 py-2 rounded font-bold"
          style={{ background: C.stamp, color: "#fff" }}
        >
          הורד מלאי
        </button>
        <button
          onClick={() => { onAdjust(product, qty); onClose(); }}
          className="flex-1 py-2 rounded font-bold"
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
function OrderTab({ lowStock, settings, persistSettings, isManager }) {
  const [phone, setPhone] = useState(settings.supplierPhone || "");
  const [qtys, setQtys] = useState(() =>
    Object.fromEntries(lowStock.map((p) => [p.id, Math.max(1, Number(p.threshold) * 2 - Number(p.quantity))]))
  );

  useEffect(() => {
    setQtys(Object.fromEntries(lowStock.map((p) => [p.id, qtys[p.id] ?? Math.max(1, Number(p.threshold) * 2 - Number(p.quantity))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowStock.length]);

  function buildMessage() {
    const lines = lowStock.map((p) => `- ${p.name}: ${qtys[p.id] || 1} ${p.unit}`);
    return `📦 הזמנה למחסן המטבח (${todayStr()}):\n${lines.join("\n")}`;
  }

  async function sendOrder() {
    const cleanPhone = phone.replace(/\D/g, "");
    const msg = encodeURIComponent(buildMessage());
    const url = cleanPhone ? `https://wa.me/${cleanPhone}?text=${msg}` : `https://wa.me/?text=${msg}`;
    window.open(url, "_blank");
  }

  return (
    <div>
      <h2 className="wh-display font-black text-lg mb-3" style={{ color: C.ink }}>מוצרים מתחת לסף</h2>

      {isManager && (
        <div className="mb-4">
          <label className="text-xs" style={{ color: C.steel }}>מספר וואטסאפ של הספק (עם קידומת מדינה, לדוגמה 972501234567)</label>
          <div className="flex gap-2 mt-1">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="flex-1 p-2 rounded border"
              style={{ borderColor: C.kraftDark, direction: "ltr" }}
            />
            <button
              onClick={() => persistSettings({ ...settings, supplierPhone: phone })}
              className="px-3 rounded text-sm font-bold"
              style={{ background: C.kraft, border: `1px solid ${C.kraftDark}`, color: C.ink }}
            >
              שמור
            </button>
          </div>
        </div>
      )}

      {lowStock.length === 0 ? (
        <ShelfTag accent={C.sage}>
          <p style={{ color: C.sage }} className="font-bold text-center">כל המלאי תקין ✓</p>
        </ShelfTag>
      ) : (
        <>
          <div className="flex flex-col gap-3 mb-4">
            {lowStock.map((p) => (
              <ShelfTag key={p.id} accent={C.stamp}>
                <div className="flex justify-between items-center">
                  <div>
                    <div className="wh-display font-bold" style={{ color: C.ink }}>{p.name}</div>
                    <div className="text-xs" style={{ color: C.steel }}>יש במלאי: {p.quantity} {p.unit} (סף: {p.threshold})</div>
                  </div>
                  <input
                    type="number"
                    value={qtys[p.id] || 1}
                    onChange={(e) => setQtys((q) => ({ ...q, [p.id]: Math.max(1, Number(e.target.value)) }))}
                    className="w-16 text-center p-2 rounded border"
                    style={{ borderColor: C.kraftDark }}
                  />
                </div>
              </ShelfTag>
            ))}
          </div>
          <button
            onClick={sendOrder}
            className="w-full py-3 rounded wh-display font-bold"
            style={{ background: "#25D366", color: "#fff" }}
          >
            שלח הזמנה בוואטסאפ
          </button>
        </>
      )}
    </div>
  );
}

/* ---------- Tasks Tab ---------- */
function TasksTab({ tasks, persistTasks, users, currentUser, showToast }) {
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
  }

  async function addTask(newTask) {
    const next = [...tasks, { ...newTask, id: genId(), createdAt: Date.now(), createdBy: currentUser.name, status: "open" }];
    await persistTasks(next);
    setShowNew(false);
    showToast("המשימה נוצרה");
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
          className="px-3 py-2 rounded text-sm font-bold"
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
            className="px-3 py-1 rounded text-sm font-bold"
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
          className="px-2 py-1 rounded text-sm border"
          style={{ borderColor: C.kraftDark, background: "#fff", color: C.ink }}
        >
          <option value="all">כל העובדים</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </div>

      {showNew && (
        <NewTaskForm users={users} onSubmit={addTask} onCancel={() => setShowNew(false)} />
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
                  <div className="text-xs mt-2 flex items-center gap-2">
                    <span style={{ color: C.steel }}>שויך ל:</span>
                    <select
                      value={t.assignedToId || ""}
                      onChange={(e) => reassign(t, e.target.value)}
                      className="text-xs p-1 rounded border"
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
                  className="text-xs px-2 py-1 rounded font-bold whitespace-nowrap"
                  style={{ background: t.status === "done" ? C.sage : C.kraftDark, color: t.status === "done" ? "#fff" : C.ink }}
                >
                  {t.status === "done" ? "סגור" : t.status === "in_progress" ? "בטיפול" : "פתוח"}
                </span>
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                {t.status !== "in_progress" && t.status !== "done" && (
                  <button onClick={() => updateStatus(t, "in_progress")} className="px-3 py-1 rounded text-sm font-bold" style={{ background: C.mustard, color: "#fff" }}>
                    התחל טיפול
                  </button>
                )}
                {t.status !== "done" && (
                  <button onClick={() => updateStatus(t, "done")} className="px-3 py-1 rounded text-sm font-bold" style={{ background: C.sage, color: "#fff" }}>
                    סמן כסגור
                  </button>
                )}
                <button onClick={() => notifyWhatsapp(t)} className="px-3 py-1 rounded text-sm font-bold" style={{ background: "#25D366", color: "#fff" }}>
                  עדכן בוואטסאפ
                </button>
              </div>
            </ShelfTag>
          );
        })}
      </div>
    </div>
  );
}

function NewTaskForm({ users, onSubmit, onCancel }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedToId, setAssignedToId] = useState(users[0]?.id || "");
  const [priority, setPriority] = useState("normal");
  const [location, setLocation] = useState("");

  return (
    <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="כותרת" className="p-2 rounded border" style={{ borderColor: C.kraftDark }} autoFocus />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="פירוט (אופציונלי)" className="p-2 rounded border" style={{ borderColor: C.kraftDark }} rows={2} />
      <select value={location} onChange={(e) => setLocation(e.target.value)} className="p-2 rounded border" style={{ borderColor: C.kraftDark }}>
        <option value="">בחר מקום (אופציונלי)</option>
        {LOCATIONS.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.rooms.map((r) => (
              <option key={g.group + r} value={`${g.group} · ${r}`}>{r}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <select value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)} className="p-2 rounded border" style={{ borderColor: C.kraftDark }}>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      <select value={priority} onChange={(e) => setPriority(e.target.value)} className="p-2 rounded border" style={{ borderColor: C.kraftDark }}>
        <option value="low">עדיפות נמוכה</option>
        <option value="normal">עדיפות רגילה</option>
        <option value="urgent">עדיפות דחופה</option>
      </select>
      <div className="flex gap-2">
        <button
          onClick={() => title.trim() && onSubmit({ title, description, assignedToId, priority, location })}
          className="flex-1 py-2 rounded font-bold"
          style={{ background: C.ink, color: C.paper }}
        >
          צור משימה
        </button>
        <button onClick={onCancel} className="flex-1 py-2 rounded font-bold" style={{ background: C.kraft, color: C.ink }}>
          ביטול
        </button>
      </div>
    </ShelfTag>
  );
}

/* ---------- Admin Tab ---------- */
function AdminTab({ users, persistUsers, products, persistProducts, settings, persistSettings, showToast }) {
  const [section, setSection] = useState("products");

  return (
    <div>
      <div className="flex gap-2 mb-4">
        {[["products", "מוצרים"], ["users", "עובדים"], ["settings", "הגדרות"]].map(([val, label]) => (
          <button
            key={val}
            onClick={() => setSection(val)}
            className="px-3 py-1 rounded text-sm font-bold"
            style={{ background: section === val ? C.ink : C.kraft, color: section === val ? C.paper : C.ink }}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "products" && (
        <ProductsAdmin products={products} persistProducts={persistProducts} showToast={showToast} />
      )}
      {section === "users" && (
        <UsersAdmin users={users} persistUsers={persistUsers} showToast={showToast} />
      )}
      {section === "settings" && (
        <ShelfTag accent={C.steel}>
          <p className="text-sm" style={{ color: C.steel }}>
            מספר הוואטסאפ של הספק מוגדר במסך "הזמנה". הגדרות נוספות יתווספו כאן בהמשך.
          </p>
        </ShelfTag>
      )}
    </div>
  );
}

const PRODUCT_CATEGORIES = [
  "מוצרים יבשים",
  "קירור וחלב",
  "בשר ועוף",
  "ירקות ופירות",
  "קפואים",
  "אפייה",
  "משקאות",
  "חד פעמי וניקיון",
  "אחר",
];

function ProductsAdmin({ products, persistProducts, showToast }) {
  const empty = { name: "", barcode: "", quantity: 0, threshold: 1, price: 0, unit: "יח׳", unitsPerCarton: 0, category: "" };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const formRef = useRef(null);

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
        return { name: String(name), barcode, quantity, threshold, price, unit, unitsPerCarton, category };
      })
      .filter(Boolean);

    if (imported.length === 0) {
      showToast("לא נמצאו שורות עם שם מוצר תקין");
      return;
    }
    let next = [...products];
    let added = 0, updated = 0;
    for (const item of imported) {
      const existingIdx = item.barcode ? next.findIndex((p) => p.barcode && p.barcode === item.barcode) : -1;
      if (existingIdx >= 0) {
        next[existingIdx] = { ...next[existingIdx], ...item };
        updated++;
      } else {
        next.push({ ...item, id: genId() });
        added++;
      }
    }
    await persistProducts(next);
    showToast(`יובאו ${added} מוצרים חדשים, עודכנו ${updated}`);
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
        <div className="flex gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="flex-1 py-2 rounded font-bold text-sm"
            style={{ background: C.mustard, color: C.ink }}
          >
            {importing ? "מייבא..." : "📥 בחר קובץ אקסל/CSV"}
          </button>
          <button
            onClick={() => setPasteMode((v) => !v)}
            className="flex-1 py-2 rounded font-bold text-sm"
            style={{ background: C.kraft, color: C.ink, border: `1px solid ${C.kraftDark}` }}
          >
            📋 הדבקת נתונים
          </button>
        </div>
        <p className="text-xs mt-1 text-center" style={{ color: C.steel }}>
          עמודות מזוהות: שם מוצר, ברקוד, כמות, סף מינימום, מחיר, יחידה (התאמה לפי ברקוד מעדכנת מוצר קיים)
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
              className="p-2 rounded border text-xs"
              style={{ borderColor: C.kraftDark, direction: "ltr", fontFamily: "monospace" }}
            />
            <button
              onClick={handlePasteImport}
              disabled={importing}
              className="py-2 rounded font-bold text-sm"
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
          <input placeholder="שם מוצר" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>ברקוד</label>
          <input placeholder="ברקוד" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>כמות במלאי</label>
            <input type="number" placeholder="כמות" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>סף מינימום</label>
            <input type="number" placeholder="סף מינ׳" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>מחיר ליחידה (₪)</label>
            <input type="number" placeholder="מחיר ליחידה" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
          <div className="flex-1">
            <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>יחידת מידה</label>
            <input placeholder="ק״ג, יח׳..." value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
          </div>
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>יחידות בקרטון (אופציונלי)</label>
          <input type="number" placeholder="יחידות בקרטון" value={form.unitsPerCarton || ""} onChange={(e) => setForm({ ...form, unitsPerCarton: Number(e.target.value) })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>קטגוריה</label>
          <select value={form.category || ""} onChange={(e) => setForm({ ...form, category: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="">ללא קטגוריה</option>
            {PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded font-bold" style={{ background: C.ink, color: C.paper }}>
            {editingId ? "שמור שינויים" : "הוסף מוצר"}
          </button>
          {editingId && (
            <button onClick={() => { setForm(empty); setEditingId(null); }} className="flex-1 py-2 rounded font-bold" style={{ background: C.kraft, color: C.ink }}>
              ביטול
            </button>
          )}
        </div>
      </ShelfTag>
      </div>

      <div className="flex flex-col gap-4">
        {Object.entries(
          products.reduce((acc, p) => {
            const cat = p.category || "ללא קטגוריה";
            (acc[cat] = acc[cat] || []).push(p);
            return acc;
          }, {})
        ).map(([cat, items]) => (
          <div key={cat}>
            <div className="wh-display font-bold text-sm mb-2" style={{ color: C.steel }}>{cat} ({items.length})</div>
            <div className="flex flex-col gap-2">
              {items.map((p) => (
                <div key={p.id} className="flex justify-between items-center p-3 rounded" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
                  <div>
                    <div className="font-bold text-sm" style={{ color: C.ink }}>{p.name}</div>
                    <div className="text-xs" style={{ color: C.steel }}>₪{Number(p.price).toFixed(2)} · {p.quantity} {p.unit}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => startEdit(p)} className="text-xs px-2 py-1 rounded" style={{ background: C.kraft }}>ערוך</button>
                    <button onClick={() => remove(p.id)} className="text-xs px-2 py-1 rounded" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
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

function UsersAdmin({ users, persistUsers, showToast }) {
  const empty = { name: "", password: "", phone: "", role: "staff" };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);

  async function save() {
    if (!form.name.trim() || !form.password.trim()) return showToast("יש להזין שם וסיסמה");
    let next;
    if (editingId) {
      next = users.map((u) => (u.id === editingId ? { ...form, id: editingId } : u));
    } else {
      next = [...users, { ...form, id: genId() }];
    }
    await persistUsers(next);
    setForm(empty);
    setEditingId(null);
    showToast("העובד נשמר");
  }

  async function remove(id) {
    if (users.length <= 1) return showToast("חייב להישאר לפחות משתמש אחד");
    await persistUsers(users.filter((u) => u.id !== id));
  }

  return (
    <div>
      <ShelfTag accent={C.mustard} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="wh-display font-bold mb-1" style={{ color: C.ink }}>
          {editingId ? "עריכת עובד" : "הוספת עובד"}
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>שם</label>
          <input placeholder="שם" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>סיסמה</label>
          <input placeholder="סיסמה" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>טלפון (לוואטסאפ, לדוגמה 972501234567)</label>
          <input placeholder="972501234567" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark, direction: "ltr" }} />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1" style={{ color: C.steel }}>תפקיד</label>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="p-2 rounded border w-full" style={{ borderColor: C.kraftDark }}>
            <option value="staff">עובד</option>
            <option value="manager">מנהל</option>
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded font-bold" style={{ background: C.ink, color: C.paper }}>
            {editingId ? "שמור שינויים" : "הוסף עובד"}
          </button>
          {editingId && (
            <button onClick={() => { setForm(empty); setEditingId(null); }} className="flex-1 py-2 rounded font-bold" style={{ background: C.kraft, color: C.ink }}>
              ביטול
            </button>
          )}
        </div>
      </ShelfTag>

      <div className="flex flex-col gap-2">
        {users.map((u) => (
          <div key={u.id} className="flex justify-between items-center p-3 rounded" style={{ background: "#fff", border: `1px solid ${C.kraftDark}` }}>
            <div>
              <div className="font-bold text-sm" style={{ color: C.ink }}>{u.name} {u.role === "manager" && "👑"}</div>
              <div className="text-xs" style={{ color: C.steel, direction: "ltr", textAlign: "right" }}>{u.phone || "ללא טלפון"}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setForm(u); setEditingId(u.id); }} className="text-xs px-2 py-1 rounded" style={{ background: C.kraft }}>ערוך</button>
              <button onClick={() => remove(u.id)} className="text-xs px-2 py-1 rounded" style={{ background: C.stamp, color: "#fff" }}>מחק</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
