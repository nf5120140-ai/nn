import { useEffect, useRef, useState, useCallback } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { supabase } from "./supabaseClient"; // ← התאם לנתיב של ה-client הקיים שלך

/*
  מותאם למבנה הנתונים שלך:
  - המוצרים שמורים כמערך JSON תחת המפתח 'kitchen-products' בטבלת kv_store
  - שדה ברקוד: barcode | שדה כמות: quantity | שם: name
  - כל הלוגיקה של הורדת המלאי קורית בפונקציה decrement_kitchen_stock ב-Supabase
  - התקנה: npm install html5-qrcode  (כבר עשית)
*/

// ---------- תור אופליין ב-IndexedDB ----------
const DB_NAME = "scan_queue_db";
const STORE = "pending_scans";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "localId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queuePut(item) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function queueGetAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function queueDelete(localId) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(localId);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---------- שליחת סריקה לשרת ----------
async function sendDecrement(barcode, amount = 1) {
  const { data, error } = await supabase.rpc("decrement_kitchen_stock", {
    p_barcode: barcode,
    p_amount: amount,
  });
  if (error) throw error;
  return data || null; // null = הברקוד לא קיים ברשימת המוצרים
}

async function flushQueue(setToast) {
  const pending = await queueGetAll();
  for (const item of pending) {
    try {
      await sendDecrement(item.barcode, item.amount);
      await queueDelete(item.localId);
    } catch (e) {
      break; // אין רשת עדיין — ננסה שוב בפעם הבאה
    }
  }
  if (pending.length) setToast?.({ type: "ok", text: `סונכרנו ${pending.length} סריקות ממתינות` });
}

// ---------- הקומפוננטה ----------
export default function InventoryScanner() {
  const scannerRef = useRef(null);
  const readerId = "reader";
  const lastScanRef = useRef({ code: null, ts: 0 });

  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const goOnline = () => { setOnline(true); flushQueue(setToast); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    flushQueue(setToast);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const handleScan = useCallback(async (decodedText) => {
    const now = Date.now();
    if (lastScanRef.current.code === decodedText && now - lastScanRef.current.ts < 2000) return;
    lastScanRef.current = { code: decodedText, ts: now };

    const barcode = decodedText.trim();

    if (!online) {
      await queuePut({ localId: `${barcode}-${now}`, barcode, amount: 1, ts: now });
      setHistory((h) => [{ barcode, name: "(ממתין לסנכרון)", qty: "—", ts: now }, ...h].slice(0, 20));
      setToast({ type: "queued", text: `נשמר לתור: ${barcode}` });
      return;
    }

    try {
      const product = await sendDecrement(barcode, 1);
      if (!product) {
        setToast({ type: "warn", text: `ברקוד לא מזוהה: ${barcode}` });
        return;
      }
      setHistory((h) => [{ barcode, name: product.name, qty: product.quantity, ts: now }, ...h].slice(0, 20));
      setToast({ type: "ok", text: `${product.name} → נותרו ${product.quantity}` });
    } catch (e) {
      await queuePut({ localId: `${barcode}-${now}`, barcode, amount: 1, ts: now });
      setToast({ type: "warn", text: `שגיאה — נשמר לתור: ${barcode}` });
    }
  }, [online]);

  const start = useCallback(async () => {
    try {
      const scanner = new Html5Qrcode(readerId);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        handleScan,
        () => {}
      );
      setRunning(true);
    } catch (e) {
      setToast({ type: "warn", text: "לא ניתן להפעיל מצלמה — בדוק הרשאות" });
    }
  }, [handleScan]);

  const stop = useCallback(async () => {
    try {
      await scannerRef.current?.stop();
      scannerRef.current?.clear();
    } catch (_) {}
    setRunning(false);
  }, []);

  useEffect(() => () => { scannerRef.current?.stop().catch(() => {}); }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const toastColor = { ok: "#16a34a", warn: "#dc2626", queued: "#d97706" }[toast?.type] || "#334155";

  return (
    <div dir="rtl" style={{ maxWidth: 480, margin: "0 auto", fontFamily: "system-ui", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>סריקת מלאי</h2>
        <span style={{ fontSize: 13, color: online ? "#16a34a" : "#dc2626" }}>
          {online ? "● מחובר" : "● אופליין"}
        </span>
      </div>

      <div id={readerId} style={{ width: "100%", borderRadius: 12, overflow: "hidden", background: "#000" }} />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {!running ? (
          <button onClick={start} style={btn("#2563eb")}>הפעל מצלמה</button>
        ) : (
          <button onClick={stop} style={btn("#64748b")}>עצור</button>
        )}
      </div>

      {toast && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "#f1f5f9", color: toastColor, fontWeight: 600 }}>
          {toast.text}
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>סריקות אחרונות</div>
          {history.map((h) => (
            <div key={h.ts} style={{ display: "flex", justifyContent: "space-between", padding: "8px 4px", borderBottom: "1px solid #e2e8f0", fontSize: 14 }}>
              <span>{h.name}</span>
              <span style={{ color: "#64748b" }}>נותרו: {h.qty}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btn = (bg) => ({
  flex: 1, padding: "12px", border: "none", borderRadius: 8,
  background: bg, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer",
});
