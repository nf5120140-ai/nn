import React, { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";

/* ============================================================
   ניהול חדרים (פנימייה) - מודול עצמאי
   הנתונים נשמרים ב-kv_store דרך loadKey/saveKey של האפליקציה:
     dorm-rooms     - [{ id, num, wing, beds, notes, updatedAt }]
     dorm-students  - [{ id, name, room, shiur, phone, notes, updatedAt }]
     dorm-deletes   - [id, ...]  (רשימת מחיקות, כדי שפריט שנמחק לא "יחזור" ממכשיר אחר)
   ============================================================ */

export const DORM_KEYS = {
  rooms: "dorm-rooms",
  students: "dorm-students",
  deletes: "dorm-deletes",
};

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const cleanName = (s) => String(s == null ? "" : s).replace(/[\t ]/g, " ").replace(/\s+/g, " ").trim();

const defaultWing = (num) => `קומה ${Math.floor(Number(num) / 100)}`;

const sortRooms = (a, b) => (Number(a.num) || 0) - (Number(b.num) || 0);

/* ---------- Parsing (Excel / Word) - pure functions ---------- */

const ROOM_RE = /חדר\s*-?\s*(\d+)/;
const CAP_RE = /\[\s*(\d+)\s*\]/;
const CAP_LINE_RE = /^\s*-?\s*\[\s*\d+\s*\]\s*-?\s*$/;

export function roomOf(text) {
  const m = ROOM_RE.exec(text || "");
  if (!m) return null;
  const c = CAP_RE.exec(text || "");
  return { num: Number(m[1]), beds: c ? Number(c[1]) : 0 };
}

function isSkipLine(line) {
  const t = cleanName(line);
  return !t || t === "*" || t === "-" || CAP_LINE_RE.test(t) || ROOM_RE.test(t);
}

/** Parse rows (array of arrays) from a sheet. Finds a header row with "שם" / "חדר". */
function parseStudentRows(rows) {
  const out = [];
  let nameCol = -1, roomCol = -1, shiurCol = -1, phoneCol = -1, notesCol = -1, start = 0;
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    let n = -1, rm = -1, sh = -1, ph = -1, no = -1;
    row.forEach((v, c) => {
      const t = String(v || "");
      if (n < 0 && t.includes("שם")) n = c;
      else if (rm < 0 && t.includes("חדר")) rm = c;
      else if (sh < 0 && (t.includes("שיעור") || t.includes("שנתון"))) sh = c;
      else if (ph < 0 && t.includes("טלפון")) ph = c;
      else if (no < 0 && t.includes("הערות")) no = c;
    });
    if (n >= 0) { nameCol = n; roomCol = rm; shiurCol = sh; phoneCol = ph; notesCol = no; start = r + 1; break; }
  }
  if (nameCol < 0) { nameCol = 0; roomCol = 1; start = 0; }
  for (let r = start; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = cleanName(row[nameCol]);
    if (!name || name === "*") continue;
    const roomNum = roomCol >= 0 ? parseInt(String(row[roomCol] || "").replace(/[^\d]/g, ""), 10) : NaN;
    out.push({
      name,
      room: Number.isFinite(roomNum) && roomNum > 0 ? roomNum : null,
      shiur: shiurCol >= 0 ? cleanName(row[shiurCol]) : "",
      phone: phoneCol >= 0 ? cleanName(row[phoneCol]) : "",
      notes: notesCol >= 0 ? cleanName(row[notesCol]) : "",
    });
  }
  return out;
}

/** Rooms sheet: columns חדר / אגף / מיטות / הערות */
function parseRoomRows(rows) {
  const out = [];
  let numCol = -1, wingCol = -1, bedsCol = -1, notesCol = -1, start = 0;
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    let n = -1, w = -1, b = -1, no = -1;
    row.forEach((v, c) => {
      const t = String(v || "");
      if (n < 0 && t.trim() === "חדר") n = c;
      else if (w < 0 && (t.includes("אגף") || t.includes("קומה"))) w = c;
      else if (b < 0 && t.includes("מיטות")) b = c;
      else if (no < 0 && t.includes("הערות")) no = c;
    });
    if (n >= 0 && b >= 0) { numCol = n; wingCol = w; bedsCol = b; notesCol = no; start = r + 1; break; }
  }
  if (numCol < 0) return out;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r] || [];
    const num = parseInt(String(row[numCol] || "").replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(num) || num <= 0) continue;
    const beds = parseInt(String(row[bedsCol] || ""), 10);
    out.push({
      num,
      beds: Number.isFinite(beds) ? beds : 0,
      wing: wingCol >= 0 ? cleanName(row[wingCol]) : "",
      notes: notesCol >= 0 ? cleanName(row[notesCol]) : "",
    });
  }
  return out;
}

export function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: "array" });
  const names = wb.SheetNames || [];
  const studentSheet = names.find((n) => n.trim() === "בחורים") || names[0];
  const roomSheet = names.find((n) => n.trim() === "חדרים");
  const toRows = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: "", raw: false });
  const students = studentSheet ? parseStudentRows(toRows(studentSheet)) : [];
  const rooms = roomSheet ? parseRoomRows(toRows(roomSheet)) : [];
  return { students, rooms };
}

/* Minimal .docx (zip) reader - uses the browser's built-in DecompressionStream */
async function unzipEntry(buf, wanted) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name !== wanted) continue;
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const data = u8.subarray(start, start + csize);
    if (method === 0) return dec.decode(data);
    if (method !== 8) throw new Error("unsupported zip method");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  }
  return null;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const kids = (el, local) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1 && n.localName === local);
function wAttr(el, local) {
  if (!el) return null;
  return el.getAttributeNS(W_NS, local) || el.getAttribute("w:" + local);
}
function paraText(p) {
  let s = "";
  const walk = (n) => {
    Array.from(n.childNodes || []).forEach((c) => {
      if (c.nodeType !== 1) return;
      if (c.localName === "t") s += c.textContent;
      else if (c.localName === "tab") s += " ";
      else if (c.localName === "br" || c.localName === "cr") s += "\n";
      else if (c.localName !== "tbl") walk(c);
    });
  };
  walk(p);
  return s;
}
function cellText(tc) {
  return kids(tc, "p").map(paraText).join("\n");
}

/** Parse Word XML. Tables: a cell with "חדר N - [beds]" and the names either in the same
    cell or in the cell directly below it (same grid column). Otherwise: lines of text. */
export function parseDocXml(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0] || doc.documentElement;
  const students = [];
  const rooms = new Map();
  const addRoom = (num, beds) => {
    const cur = rooms.get(num);
    if (!cur) rooms.set(num, { num, beds: beds || 0 });
    else if (beds) cur.beds = beds;
  };
  const addNames = (text, num) => {
    String(text).split("\n").forEach((line) => {
      if (isSkipLine(line)) return;
      students.push({ name: cleanName(line), room: num || null, shiur: "", phone: "", notes: "" });
    });
  };

  const tables = Array.from(doc.getElementsByTagNameNS(W_NS, "tbl"));
  if (tables.length) {
    tables.forEach((tbl) => {
      const pending = new Map(); // grid column -> room number waiting for its names cell
      kids(tbl, "tr").forEach((tr) => {
        let col = 0;
        kids(tr, "tc").forEach((tc) => {
          const pr = kids(tc, "tcPr")[0];
          const span = Number(wAttr(pr && kids(pr, "gridSpan")[0], "val")) || 1;
          const vm = pr && kids(pr, "vMerge")[0];
          const isContinuation = vm && wAttr(vm, "val") !== "restart";
          const key = col;
          col += span;
          if (isContinuation) return;
          const text = cellText(tc);
          const hdr = roomOf(text);
          if (hdr) {
            addRoom(hdr.num, hdr.beds);
            const before = students.length;
            addNames(text, hdr.num);
            if (students.length === before) pending.set(key, hdr.num);
            else pending.delete(key);
          } else if (pending.has(key)) {
            addNames(text, pending.get(key));
            pending.delete(key);
          }
        });
      });
    });
  } else {
    const lines = kids(body, "p").map(paraText).join("\n").split("\n");
    const hasHeaders = lines.some((l) => roomOf(l));
    let cur = null;
    lines.forEach((raw) => {
      const line = cleanName(raw);
      if (!line) return;
      const hdr = roomOf(line);
      if (hdr) { cur = hdr.num; addRoom(hdr.num, hdr.beds); return; }
      if (isSkipLine(line)) return;
      const m = /^(.*?)[\s\-,:]+(\d+)$/.exec(line);
      if (m && cleanName(m[1])) students.push({ name: cleanName(m[1]), room: Number(m[2]), shiur: "", phone: "", notes: "" });
      else if (cur || !hasHeaders) students.push({ name: line, room: cur, shiur: "", phone: "", notes: "" });
    });
  }
  return { students, rooms: [...rooms.values()].map((r) => ({ ...r, wing: "", notes: "" })) };
}

export async function parseImportFile(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  const lower = (file.name || "").toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) {
    if (head[0] === 0xd0 && head[1] === 0xcf) {
      throw new Error("הקובץ מוגן בסיסמה או בפורמט וורד ישן. פתח אותו בוורד, הסר את הסיסמה ושמור כ-docx, ונסה שוב.");
    }
    const xml = await unzipEntry(buf, "word/document.xml");
    if (!xml) throw new Error("לא נמצא תוכן בקובץ הוורד");
    return parseDocXml(xml);
  }
  return parseWorkbook(buf);
}

/* ---------- Print (opens a print window) ---------- */

function openPrint(title, bodyHtml, extraCss = "") {
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="UTF-8" /><title>${esc(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #111; margin: 0; padding: 6px; }
    h1 { text-align: center; font-size: 18px; margin: 0 0 6px; }
    h2 { font-size: 15px; margin: 10px 0 4px; }
    ${extraCss}
  </style></head><body>${bodyHtml}<script>window.onload = () => window.print();</script></body></html>`;
  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  return true;
}

/* ============================================================
   Component
   ============================================================ */

export default function DormRoomsTab({ C, currentUser, showToast, loadKey, saveKey, loadListFresh, reloadSignal, canEdit = true }) {
  const [rooms, setRooms] = useState([]);
  const [students, setStudents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("home");
  const [busy, setBusy] = useState(false);
  const [editStudent, setEditStudent] = useState(null);
  const [importData, setImportData] = useState(null);

  const toast = (m) => (showToast ? showToast(m) : alert(m));

  /* ---------- load ---------- */
  async function loadAll() {
    try {
      const [r, s, d] = await Promise.all([
        loadKey(DORM_KEYS.rooms, []),
        loadKey(DORM_KEYS.students, []),
        loadKey(DORM_KEYS.deletes, []),
      ]);
      const del = new Set(Array.isArray(d) ? d : []);
      setRooms((Array.isArray(r) ? r : []).filter((x) => x && !del.has(x.id)));
      setStudents((Array.isArray(s) ? s : []).filter((x) => x && !del.has(x.id)));
    } catch (e) {
      console.error("dorm load failed", e);
    }
    setLoaded(true);
  }
  useEffect(() => { loadAll(); }, [reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- safe read-modify-write ---------- */
  async function freshList(key) {
    const list = (loadListFresh ? await loadListFresh(key) : await loadKey(key, [])) || [];
    let dels = [];
    try { dels = (await loadKey(DORM_KEYS.deletes, [])) || []; } catch (e) {}
    const del = new Set(dels);
    return list.filter((x) => x && !del.has(x.id));
  }
  async function addDeletes(ids) {
    if (!ids.length) return;
    let dels = [];
    try { dels = (await loadKey(DORM_KEYS.deletes, [])) || []; } catch (e) {}
    const set = new Set(dels);
    ids.forEach((id) => set.add(id));
    await saveKey(DORM_KEYS.deletes, [...set]);
  }
  async function mutateStudents(fn) {
    const cur = await freshList(DORM_KEYS.students);
    const curRooms = await freshList(DORM_KEYS.rooms);
    const next = fn(cur, curRooms);
    await saveKey(DORM_KEYS.students, next);
    setStudents(next);
    setRooms(curRooms);
    return next;
  }
  async function mutateRooms(fn) {
    const cur = await freshList(DORM_KEYS.rooms);
    const next = fn(cur);
    await saveKey(DORM_KEYS.rooms, next);
    setRooms(next);
    return next;
  }
  async function run(fn) {
    if (busy) return false;
    setBusy(true);
    try { await fn(); return true; }
    catch (e) { toast(e && e.message ? e.message : "שגיאה"); console.error(e); return false; }
    finally { setBusy(false); }
  }

  /* ---------- derived ---------- */
  const sortedRooms = useMemo(() => [...rooms].sort(sortRooms), [rooms]);
  const byRoom = useMemo(() => {
    const m = new Map();
    students.forEach((s) => {
      if (s.room == null || s.room === "") return;
      const k = Number(s.room);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    });
    m.forEach((list) => list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name, "he")));
    return m;
  }, [students]);
  const roomInfo = (r) => {
    const taken = (byRoom.get(Number(r.num)) || []).length;
    const beds = Number(r.beds) || 0;
    return { taken, beds, free: beds - taken };
  };
  const wings = useMemo(() => {
    const order = [];
    sortedRooms.forEach((r) => { const w = r.wing || defaultWing(r.num); if (!order.includes(w)) order.push(w); });
    return order;
  }, [sortedRooms]);
  const roomByNum = useMemo(() => new Map(rooms.map((r) => [Number(r.num), r])), [rooms]);
  const wingOf = (num) => { const r = roomByNum.get(Number(num)); return r ? (r.wing || defaultWing(r.num)) : ""; };

  const stats = useMemo(() => {
    let beds = 0, taken = 0, over = 0, freeRooms = 0;
    sortedRooms.forEach((r) => {
      const i = roomInfo(r);
      beds += i.beds; taken += i.taken;
      if (i.free < 0) over++;
      if (i.free > 0) freeRooms++;
    });
    const unassigned = students.filter((s) => s.room == null || s.room === "" || !roomByNum.has(Number(s.room))).length;
    return { beds, taken, free: beds - taken, over, freeRooms, unassigned, total: students.length };
  }, [sortedRooms, students, byRoom]); // eslint-disable-line react-hooks/exhaustive-deps

  const freeRooms = sortedRooms.filter((r) => roomInfo(r).free > 0);

  /* ---------- actions ---------- */
  function assertRoomHasSpace(roomNum, list, roomList, ignoreId) {
    const r = roomList.find((x) => Number(x.num) === Number(roomNum));
    if (!r) throw new Error(`חדר ${roomNum} לא קיים`);
    const taken = list.filter((s) => Number(s.room) === Number(roomNum) && s.id !== ignoreId).length;
    if (taken >= (Number(r.beds) || 0)) throw new Error(`חדר ${roomNum} מלא (${r.beds} מיטות). אי אפשר להוסיף אליו עוד בחור.`);
  }

  function addStudent(name, roomNum) {
    const n = cleanName(name);
    if (!n) { toast("יש לרשום את שם הבחור"); return Promise.resolve(false); }
    let ok = false;
    return run(async () => {
      await mutateStudents((list, roomList) => {
        if (roomNum != null && roomNum !== "") assertRoomHasSpace(roomNum, list, roomList);
        const now = Date.now();
        return [...list, { id: uid(), name: n, room: roomNum === "" || roomNum == null ? null : Number(roomNum), shiur: "", phone: "", notes: "", createdAt: now, updatedAt: now }];
      });
      ok = true;
      toast(roomNum ? `${n} נוסף לחדר ${roomNum}` : `${n} נוסף (ללא חדר)`);
    }).then(() => ok);
  }

  function updateStudent(id, patch) {
    return run(async () => {
      await mutateStudents((list, roomList) => {
        const cur = list.find((s) => s.id === id);
        if (!cur) throw new Error("הבחור לא נמצא (אולי נמחק במכשיר אחר)");
        if (patch.room != null && patch.room !== "" && Number(patch.room) !== Number(cur.room)) {
          assertRoomHasSpace(patch.room, list, roomList, id);
        }
        return list.map((s) => (s.id === id ? { ...s, ...patch, room: patch.room === "" ? null : (patch.room !== undefined ? (patch.room == null ? null : Number(patch.room)) : s.room), updatedAt: Date.now() } : s));
      });
    });
  }

  function deleteStudent(s) {
    if (!window.confirm(`למחוק את ${s.name}?`)) return;
    run(async () => {
      await addDeletes([s.id]);
      await mutateStudents((list) => list.filter((x) => x.id !== s.id));
      toast(`${s.name} נמחק`);
    });
  }

  function saveRoom(room) {
    return run(async () => {
      const num = parseInt(room.num, 10);
      if (!Number.isFinite(num) || num <= 0) throw new Error("מספר חדר לא תקין");
      await mutateRooms((list) => {
        if (list.some((r) => Number(r.num) === num && r.id !== room.id)) throw new Error(`חדר ${num} כבר קיים`);
        const clean = { num, wing: cleanName(room.wing) || defaultWing(num), beds: Math.max(0, parseInt(room.beds, 10) || 0), notes: cleanName(room.notes), updatedAt: Date.now() };
        if (room.id) return list.map((r) => (r.id === room.id ? { ...r, ...clean } : r));
        return [...list, { id: uid(), ...clean }];
      });
      // if the room number changed, move its students with it
      if (room.id && room.oldNum != null && Number(room.oldNum) !== num) {
        await mutateStudents((list) => list.map((s) => (Number(s.room) === Number(room.oldNum) ? { ...s, room: num, updatedAt: Date.now() } : s)));
      }
      toast("החדר נשמר");
    });
  }

  function deleteRoom(r) {
    const taken = (byRoom.get(Number(r.num)) || []).length;
    if (taken > 0) { toast(`בחדר ${r.num} יש ${taken} בחורים. קודם מעבירים אותם לחדר אחר.`); return; }
    if (!window.confirm(`למחוק את חדר ${r.num}?`)) return;
    run(async () => {
      await addDeletes([r.id]);
      await mutateRooms((list) => list.filter((x) => x.id !== r.id));
      toast(`חדר ${r.num} נמחק`);
    });
  }

  async function handleImportFile(file) {
    if (!file) return;
    setBusy(true);
    try {
      const data = await parseImportFile(file);
      if (!data.students.length && !data.rooms.length) { toast("לא נמצאו בחורים או חדרים בקובץ"); return; }
      setImportData({ ...data, fileName: file.name });
    } catch (e) {
      toast(e.message || "לא ניתן לקרוא את הקובץ");
    } finally {
      setBusy(false);
    }
  }

  function applyImport(mode) {
    const data = importData;
    setImportData(null);
    run(async () => {
      const now = Date.now();
      // rooms: from the file's rooms list + any room number a student points at
      const fileRooms = new Map();
      data.rooms.forEach((r) => fileRooms.set(r.num, r));
      const countInFile = new Map();
      data.students.forEach((s) => { if (s.room) countInFile.set(s.room, (countInFile.get(s.room) || 0) + 1); });
      countInFile.forEach((_, num) => { if (!fileRooms.has(num)) fileRooms.set(num, { num, beds: 0, wing: "", notes: "" }); });

      await mutateRooms((list) => {
        const next = list.map((r) => {
          const f = fileRooms.get(Number(r.num));
          if (!f) return r;
          return { ...r, beds: f.beds || r.beds, wing: f.wing || r.wing, notes: f.notes || r.notes, updatedAt: now };
        });
        fileRooms.forEach((f, num) => {
          if (next.some((r) => Number(r.num) === num)) return;
          next.push({ id: uid(), num, wing: f.wing || defaultWing(num), beds: f.beds || countInFile.get(num) || 1, notes: f.notes || "", updatedAt: now });
        });
        return next;
      });

      let added = 0, skipped = 0;
      if (mode === "replace") {
        const cur = await freshList(DORM_KEYS.students);
        await addDeletes(cur.map((s) => s.id));
        const next = data.students.map((s, i) => ({ id: uid(), ...s, createdAt: now + i, updatedAt: now }));
        await saveKey(DORM_KEYS.students, next);
        setStudents(next);
        added = next.length;
      } else {
        await mutateStudents((list) => {
          const names = new Set(list.map((s) => cleanName(s.name)));
          const extra = [];
          data.students.forEach((s, i) => {
            if (names.has(s.name)) { skipped++; return; }
            names.add(s.name);
            extra.push({ id: uid(), ...s, createdAt: now + i, updatedAt: now });
          });
          added = extra.length;
          return [...list, ...extra];
        });
      }
      toast(`הייבוא הסתיים: נוספו ${added} בחורים${skipped ? `, ${skipped} דולגו כי כבר קיימים` : ""}`);
    });
  }

  function exportExcel() {
    const sRows = [...students]
      .sort((a, b) => (Number(a.room) || 99999) - (Number(b.room) || 99999) || a.name.localeCompare(b.name, "he"))
      .map((s) => ({ "שם הבחור": s.name, "חדר": s.room || "", "אגף / קומה": s.room ? wingOf(s.room) : "", "שיעור / שנתון": s.shiur || "", "טלפון": s.phone || "", "הערות": s.notes || "" }));
    const rRows = sortedRooms.map((r) => { const i = roomInfo(r); return { "חדר": r.num, "אגף / קומה": r.wing || defaultWing(r.num), "מיטות": i.beds, "תפוסים": i.taken, "פנויים": i.free, "הערות": r.notes || "" }; });
    const wb = XLSX.utils.book_new();
    const s1 = XLSX.utils.json_to_sheet(sRows.length ? sRows : [{ "שם הבחור": "", "חדר": "" }]);
    s1["!cols"] = [{ wch: 24 }, { wch: 8 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 30 }];
    const s2 = XLSX.utils.json_to_sheet(rRows.length ? rRows : [{ "חדר": "", "מיטות": "" }]);
    s2["!cols"] = [{ wch: 8 }, { wch: 18 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 20 }];
    if (!wb.Workbook) wb.Workbook = {};
    wb.Workbook.Views = [{ RTL: true }];
    XLSX.utils.book_append_sheet(wb, s1, "בחורים");
    XLSX.utils.book_append_sheet(wb, s2, "חדרים");
    XLSX.writeFile(wb, `סידור חדרים ${new Date().toLocaleDateString("he-IL").replace(/\./g, "-")}.xlsx`);
    toast("הקובץ יורד עכשיו");
  }

  /* ---------- printing ---------- */
  const today = new Date().toLocaleDateString("he-IL");

  function printMap(onlyWing) {
    const parts = wings.filter((w) => !onlyWing || w === onlyWing).map((w) => {
      const boxes = sortedRooms.filter((r) => (r.wing || defaultWing(r.num)) === w).map((r) => {
        const list = byRoom.get(Number(r.num)) || [];
        const beds = Number(r.beds) || 0;
        const n = Math.max(beds, list.length, 1);
        let rows = "";
        for (let i = 0; i < n; i++) {
          const over = i >= beds;
          rows += `<tr><td class="no${over ? " over" : ""}">${i < Math.max(beds, list.length) ? i + 1 : ""}</td><td>${list[i] ? esc(list[i].name) : ""}</td></tr>`;
        }
        return `<div class="room"><div class="rh">חדר ${esc(r.num)}</div><table>${rows}</table></div>`;
      }).join("");
      return `<h2>${esc(w)}</h2><div class="grid">${boxes}</div>`;
    }).join("");
    const ok = openPrint("מפת חדרים", `<h1>מפת חדרים - ${esc(today)}</h1>${parts}`, `
      .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
      .room { border: 1.5px solid #333; page-break-inside: avoid; break-inside: avoid; }
      .rh { background: #d9d9d9; font-weight: bold; text-align: center; font-size: 14px; padding: 3px; border-bottom: 1.5px solid #333; }
      table { width: 100%; border-collapse: collapse; }
      td { border-top: 1px solid #999; font-size: 12px; padding: 2px 4px; height: 19px; text-align: center; }
      td.no { width: 20px; background: #eee; border-left: 1px solid #999; font-weight: bold; }
      td.over { background: #f8c8c8; }
      h2 { page-break-after: avoid; break-after: avoid; }`);
    if (!ok) toast("הדפדפן חסם את חלון ההדפסה - יש לאפשר חלונות קופצים");
  }

  function printByRooms() {
    const parts = wings.map((w) => {
      const list = sortedRooms.filter((r) => (r.wing || defaultWing(r.num)) === w);
      let rowsHtml = "";
      for (let i = 0; i < list.length; i += 6) {
        const cells = list.slice(i, i + 6).map((r) => {
          const st = byRoom.get(Number(r.num)) || [];
          const beds = Number(r.beds) || 0;
          const stars = Math.max(0, beds - st.length);
          return `<td><b>חדר ${esc(r.num)} - [${beds}]</b>${st.map((s) => `<div>${esc(s.name)}</div>`).join("")}${"<div>*</div>".repeat(stars)}</td>`;
        });
        while (cells.length < 6) cells.push("<td></td>");
        rowsHtml += `<tr>${cells.join("")}</tr>`;
      }
      return `<h2>${esc(w)}</h2><table>${rowsHtml}</table>`;
    }).join("");
    const ok = openPrint("סידור חדרים", `<h1>סידור חדרים - ${esc(today)}</h1>${parts}`, `
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      tr { page-break-inside: avoid; break-inside: avoid; }
      td { border: 1px solid #333; vertical-align: top; text-align: center; font-size: 12px; padding: 3px; }
      td b { display: block; background: #e6e6e6; margin: -3px -3px 3px; padding: 2px; font-size: 13px; }`);
    if (!ok) toast("הדפדפן חסם את חלון ההדפסה - יש לאפשר חלונות קופצים");
  }

  /* ---------- UI helpers ---------- */
  const card = { background: C.kraft, border: `1px solid ${C.kraftDark}`, borderRadius: 20 };
  const input = { background: C.paper, color: C.ink, border: `1px solid ${C.kraftDark}`, borderRadius: 12 };
  const btn = (primary) => ({ background: primary ? C.brand : C.paper, color: primary ? "#fff" : C.ink, border: `1px solid ${primary ? C.brand : C.kraftDark}`, borderRadius: 14 });

  const roomLabel = (r) => {
    const i = roomInfo(r);
    return `${r.num} · ${r.wing || defaultWing(r.num)} · ${i.free > 0 ? `${i.free} פנויות` : i.free === 0 ? "מלא" : "חריגה"}`;
  };

  if (!loaded) {
    return <div className="p-6 text-center wh-body" style={{ color: C.steel }}>טוען...</div>;
  }

  const TABS = [
    ["home", "ראשי"],
    ["map", "מפת חדרים"],
    ["list", "רשימת בחורים"],
    ["rooms", "חדרים וקבצים"],
  ];

  return (
    <div className="wh-body pb-24" dir="rtl" style={{ color: C.ink }}>
      <div className="flex items-center justify-between mb-3">
        <div className="wh-display font-black text-xl">🛏️ ניהול חדרים</div>
        {busy && <div className="text-xs" style={{ color: C.steel }}>שומר...</div>}
      </div>

      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className="px-4 py-2 text-sm font-bold whitespace-nowrap"
            style={{ ...btn(view === k), borderRadius: 999 }}>{l}</button>
        ))}
      </div>

      {rooms.length === 0 && view !== "rooms" && (
        <div className="p-4 mb-4 text-sm" style={card}>
          עדיין אין חדרים. אפשר להוסיף חדרים במסך <b>"חדרים וקבצים"</b>, או לייבא קובץ אקסל / וורד עם הרשימה הקיימת.
          <div className="mt-3"><button className="px-4 py-2 text-sm font-bold" style={btn(true)} onClick={() => setView("rooms")}>למסך חדרים וקבצים</button></div>
        </div>
      )}

      {view === "home" && (
        <HomeView {...{ C, card, input, btn, stats, wings, sortedRooms, roomInfo, freeRooms, roomLabel, students, wingOf, addStudent, updateStudent, deleteStudent, setEditStudent, canEdit, busy, roomByNum }} />
      )}
      {view === "map" && (
        <MapView {...{ C, card, btn, wings, sortedRooms, byRoom, roomInfo, addStudent, setEditStudent, printMap, canEdit }} />
      )}
      {view === "list" && (
        <ListView {...{ C, card, input, btn, students, sortedRooms, roomByNum, wingOf, roomInfo, wings, setEditStudent, updateStudent, canEdit }} />
      )}
      {view === "rooms" && (
        <RoomsView {...{ C, card, input, btn, sortedRooms, roomInfo, saveRoom, deleteRoom, canEdit, handleImportFile, exportExcel, printByRooms, printMap, busy }} />
      )}

      {editStudent && (
        <StudentDialog {...{ C, card, input, btn, student: editStudent, sortedRooms, roomInfo, roomLabel, canEdit,
          onClose: () => setEditStudent(null),
          onSave: async (patch) => { if (await updateStudent(editStudent.id, patch)) setEditStudent(null); },
          onDelete: () => { const s = editStudent; setEditStudent(null); deleteStudent(s); } }} />
      )}

      {importData && (
        <Modal C={C} card={card} onClose={() => setImportData(null)}>
          <div className="wh-display font-black text-lg mb-2">ייבוא מ"{importData.fileName}"</div>
          <div className="text-sm mb-1">נמצאו <b>{importData.students.length}</b> בחורים ו-<b>{importData.rooms.length}</b> חדרים.</div>
          <div className="text-xs mb-4" style={{ color: C.steel }}>
            חדרים שלא קיימים ייווצרו. אם בקובץ מופיע מספר מיטות - הוא יעודכן.
          </div>
          <div className="flex flex-col gap-2">
            <button className="py-3 font-bold text-sm" style={btn(true)} onClick={() => applyImport("replace")}>להחליף את כל רשימת הבחורים</button>
            <button className="py-3 font-bold text-sm" style={btn(false)} onClick={() => applyImport("add")}>להוסיף לרשימה הקיימת (בלי כפולים)</button>
            <button className="py-2 text-sm" style={{ color: C.steel }} onClick={() => setImportData(null)}>ביטול</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================================================
   Sub views
   ============================================================ */

function Stat({ C, label, value, warn }) {
  return (
    <div className="p-3 text-center" style={{ background: warn ? "#FDECEC" : C.kraft, border: `1px solid ${warn ? "#F5B5B5" : C.kraftDark}`, borderRadius: 16 }}>
      <div className="text-xs" style={{ color: warn ? "#9C0006" : C.steel }}>{label}</div>
      <div className="wh-display font-black text-2xl" style={{ color: warn ? "#9C0006" : C.ink }}>{value}</div>
    </div>
  );
}

function HomeView({ C, card, input, btn, stats, wings, sortedRooms, roomInfo, freeRooms, roomLabel, students, wingOf, addStudent, setEditStudent, canEdit, busy, roomByNum }) {
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [q, setQ] = useState("");
  const nameRef = useRef(null);

  const results = useMemo(() => {
    const t = q.trim();
    if (!t) return [];
    return students
      .filter((s) => s.name.includes(t) || String(s.room || "") === t)
      .sort((a, b) => (Number(a.room) || 99999) - (Number(b.room) || 99999) || a.name.localeCompare(b.name, "he"));
  }, [q, students]);

  const unassigned = students.filter((s) => s.room == null || s.room === "" || !roomByNum.has(Number(s.room)));

  async function submit(e) {
    e && e.preventDefault();
    const ok = await addStudent(name, room === "" ? null : Number(room));
    if (ok) { setName(""); setRoom(""); nameRef.current && nameRef.current.focus(); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))", gap: 8 }}>
        <Stat C={C} label="מיטות" value={stats.beds} />
        <Stat C={C} label="משובצים" value={stats.taken} />
        <Stat C={C} label="מיטות פנויות" value={stats.free} />
        <Stat C={C} label="תפוסה" value={stats.beds ? Math.round((stats.taken / stats.beds) * 100) + "%" : "-"} />
        <Stat C={C} label="ללא חדר" value={stats.unassigned} warn={stats.unassigned > 0} />
        <Stat C={C} label="חדרים בחריגה" value={stats.over} warn={stats.over > 0} />
      </div>

      {canEdit && (
        <form onSubmit={submit} className="p-4" style={card}>
          <div className="wh-display font-black mb-3">➕ הוספת בחור חדש</div>
          <div className="flex flex-wrap gap-2">
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="שם הבחור"
              className="flex-1 px-3 py-2 text-sm" style={{ ...input, minWidth: 180 }} />
            <select value={room} onChange={(e) => setRoom(e.target.value)} className="px-3 py-2 text-sm" style={{ ...input, minWidth: 220, flex: "1 1 220px" }}>
              <option value="">בחר חדר פנוי...</option>
              {freeRooms.map((r) => <option key={r.id} value={r.num}>{roomLabel(r)}</option>)}
            </select>
            <button type="submit" disabled={busy} className="px-5 py-2 text-sm font-bold" style={btn(true)}>הוסף</button>
          </div>
          {freeRooms.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs mb-1" style={{ color: C.steel }}>חדרים עם מקום פנוי (לחיצה בוחרת):</div>
              <div className="flex flex-wrap gap-1.5">
                {freeRooms.map((r) => {
                  const i = roomInfo(r);
                  const sel = String(room) === String(r.num);
                  return (
                    <button type="button" key={r.id} onClick={() => setRoom(String(r.num))}
                      className="px-2.5 py-1 text-xs font-bold"
                      style={{ borderRadius: 999, background: sel ? C.sage : "#E6F4E2", color: sel ? "#fff" : "#2F6B2A", border: "1px solid #BFE0B8" }}>
                      {r.num} · {i.free}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-xs" style={{ color: "#9C0006" }}>אין כרגע חדרים עם מקום פנוי.</div>
          )}
        </form>
      )}

      <div className="p-4" style={card}>
        <div className="wh-display font-black mb-3">🔍 חיפוש בחור</div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="שם או חלק משם (למשל: כהן), או מספר חדר"
          className="w-full px-3 py-2 text-sm" style={input} />
        {q.trim() && (
          <div className="mt-3">
            <div className="text-xs mb-2" style={{ color: C.steel }}>{results.length ? `נמצאו ${results.length}` : "לא נמצא אף בחור"}</div>
            <div className="flex flex-col gap-1">
              {results.map((s) => (
                <button key={s.id} onClick={() => setEditStudent(s)} className="flex items-center justify-between px-3 py-2 text-sm text-right"
                  style={{ background: C.paper, borderRadius: 12 }}>
                  <span className="font-bold">{s.name}</span>
                  <span style={{ color: C.steel }}>{s.room ? `חדר ${s.room} · ${wingOf(s.room)}` : "ללא חדר"}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="p-4" style={card}>
        <div className="wh-display font-black mb-2">לפי אגף / קומה</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead><tr style={{ color: C.steel }}>
              <th className="text-right py-1">אגף / קומה</th><th>חדרים</th><th>מיטות</th><th>תפוסים</th><th>פנויות</th>
            </tr></thead>
            <tbody>
              {wings.map((w) => {
                const rs = sortedRooms.filter((r) => (r.wing || defaultWing(r.num)) === w);
                let beds = 0, taken = 0;
                rs.forEach((r) => { const i = roomInfo(r); beds += i.beds; taken += i.taken; });
                return (
                  <tr key={w} style={{ borderTop: `1px solid ${C.kraftDark}` }}>
                    <td className="py-1.5 font-bold">{w}</td>
                    <td className="text-center">{rs.length}</td>
                    <td className="text-center">{beds}</td>
                    <td className="text-center">{taken}</td>
                    <td className="text-center font-bold" style={{ color: beds - taken < 0 ? "#9C0006" : beds - taken > 0 ? "#2F6B2A" : C.ink }}>{beds - taken}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {unassigned.length > 0 && (
        <div className="p-4" style={{ ...card, border: "1px solid #F5C9A0" }}>
          <div className="wh-display font-black mb-2">בחורים ללא חדר ({unassigned.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {unassigned.map((s) => (
              <button key={s.id} onClick={() => setEditStudent(s)} className="px-3 py-1 text-xs font-bold"
                style={{ borderRadius: 999, background: "#FCE4D6", color: "#8A4B12" }}>{s.name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MapView({ C, card, btn, wings, sortedRooms, byRoom, roomInfo, addStudent, setEditStudent, printMap, canEdit }) {
  const [wing, setWing] = useState("");
  const [adding, setAdding] = useState(null); // room num
  const [newName, setNewName] = useState("");
  const shownWings = wing ? [wing] : wings;

  async function saveNew(num) {
    const ok = await addStudent(newName, num);
    if (ok) { setNewName(""); setAdding(null); }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setWing("")} className="px-3 py-1.5 text-xs font-bold" style={{ ...btn(!wing), borderRadius: 999 }}>הכל</button>
        {wings.map((w) => (
          <button key={w} onClick={() => setWing(w)} className="px-3 py-1.5 text-xs font-bold" style={{ ...btn(wing === w), borderRadius: 999 }}>{w}</button>
        ))}
        <button onClick={() => printMap(wing)} className="px-3 py-1.5 text-xs font-bold mr-auto" style={{ ...btn(false), borderRadius: 999 }}>🖨️ הדפסת המפה</button>
      </div>

      {shownWings.map((w) => (
        <div key={w}>
          <div className="wh-display font-black mb-2">{w}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(165px, 1fr))", gap: 8 }}>
            {sortedRooms.filter((r) => (r.wing || defaultWing(r.num)) === w).map((r) => {
              const list = byRoom.get(Number(r.num)) || [];
              const i = roomInfo(r);
              const n = Math.max(i.beds, list.length, 1);
              const headBg = i.free < 0 ? "#C0392B" : i.free === 0 ? "#5B6B85" : "#2E7D32";
              return (
                <div key={r.id} style={{ ...card, borderRadius: 14, overflow: "hidden" }}>
                  <div className="flex items-center justify-between px-2 py-1.5" style={{ background: headBg, color: "#fff" }}>
                    <span className="wh-display font-black text-base">חדר {r.num}</span>
                    <span className="text-[11px] font-bold">{i.taken}/{i.beds}</span>
                  </div>
                  <table className="w-full text-xs" style={{ borderCollapse: "collapse" }}>
                    <tbody>
                      {Array.from({ length: n }).map((_, idx) => {
                        const s = list[idx];
                        const over = idx >= i.beds;
                        const isEmptyBed = !s && idx < i.beds;
                        return (
                          <tr key={idx} style={{ borderTop: `1px solid ${C.kraftDark}` }}>
                            <td className="text-center font-bold" style={{ width: 22, background: over ? "#F8C8C8" : C.paper, color: C.steel, borderLeft: `1px solid ${C.kraftDark}` }}>
                              {idx < Math.max(i.beds, list.length) ? idx + 1 : ""}
                            </td>
                            <td className="px-1.5 py-1">
                              {s ? (
                                <button onClick={() => setEditStudent(s)} className="w-full text-right" style={{ color: C.ink }}>{s.name}</button>
                              ) : isEmptyBed && canEdit ? (
                                adding === r.num && newName !== null ? (
                                  idx === list.length ? (
                                    <form onSubmit={(e) => { e.preventDefault(); saveNew(r.num); }} className="flex gap-1">
                                      <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="שם"
                                        className="w-full px-1 py-0.5 text-xs" style={{ border: `1px solid ${C.kraftDark}`, borderRadius: 6, background: C.paper, color: C.ink }}
                                        onKeyDown={(e) => { if (e.key === "Escape") { setAdding(null); setNewName(""); } }} />
                                      <button type="submit" className="px-1.5 text-xs font-bold" style={{ color: C.sage }}>✓</button>
                                    </form>
                                  ) : <span style={{ color: C.kraftDark }}>—</span>
                                ) : (
                                  <button onClick={() => { setAdding(r.num); setNewName(""); }} className="w-full text-right" style={{ color: "#7FB77A" }}>+ פנוי</button>
                                )
                              ) : (
                                <span style={{ color: C.kraftDark }}>—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ListView({ C, card, input, btn, students, sortedRooms, roomByNum, wingOf, roomInfo, wings, setEditStudent, updateStudent, canEdit }) {
  const [q, setQ] = useState("");
  const [wing, setWing] = useState("");
  const [onlyNoRoom, setOnlyNoRoom] = useState(false);

  const rows = useMemo(() => {
    const t = q.trim();
    return students
      .filter((s) => !t || s.name.includes(t) || (s.shiur || "").includes(t) || String(s.room || "") === t)
      .filter((s) => !wing || (s.room && wingOf(s.room) === wing))
      .filter((s) => !onlyNoRoom || !s.room || !roomByNum.has(Number(s.room)))
      .sort((a, b) => (Number(a.room) || 99999) - (Number(b.room) || 99999) || a.name.localeCompare(b.name, "he"));
  }, [q, wing, onlyNoRoom, students, roomByNum]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="סינון לפי שם / שיעור / חדר" className="flex-1 px-3 py-2 text-sm" style={{ ...input, minWidth: 200 }} />
        <select value={wing} onChange={(e) => setWing(e.target.value)} className="px-3 py-2 text-sm" style={input}>
          <option value="">כל האגפים</option>
          {wings.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm px-2">
          <input type="checkbox" checked={onlyNoRoom} onChange={(e) => setOnlyNoRoom(e.target.checked)} /> רק ללא חדר
        </label>
      </div>
      <div className="text-xs" style={{ color: C.steel }}>{rows.length} בחורים</div>
      <div className="overflow-x-auto" style={card}>
        <table className="w-full text-sm" style={{ borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr style={{ background: C.paper, color: C.steel }}>
              <th className="text-right px-3 py-2">שם הבחור</th>
              <th className="px-2">חדר</th>
              <th className="text-right px-2">שיעור / שנתון</th>
              <th className="text-right px-2">טלפון</th>
              <th className="text-right px-2">הערות</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} style={{ borderTop: `1px solid ${C.kraftDark}` }}>
                <td className="px-3 py-1.5">
                  <button onClick={() => setEditStudent(s)} className="font-bold text-right" style={{ color: C.ink }}>{s.name}</button>
                </td>
                <td className="px-2 text-center">
                  {canEdit ? (
                    <select value={s.room || ""} onChange={(e) => updateStudent(s.id, { room: e.target.value === "" ? null : Number(e.target.value) })}
                      className="px-1 py-1 text-xs" style={input}>
                      <option value="">—</option>
                      {sortedRooms.map((r) => {
                        const i = roomInfo(r);
                        const full = i.free <= 0 && Number(s.room) !== Number(r.num);
                        return <option key={r.id} value={r.num} disabled={full}>{r.num}{full ? " (מלא)" : ""}</option>;
                      })}
                    </select>
                  ) : (s.room || "—")}
                </td>
                <td className="px-2">{s.shiur}</td>
                <td className="px-2" dir="ltr" style={{ textAlign: "right" }}>{s.phone}</td>
                <td className="px-2 text-xs" style={{ color: C.steel }}>{s.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoomsView({ C, card, input, btn, sortedRooms, roomInfo, saveRoom, deleteRoom, canEdit, handleImportFile, exportExcel, printByRooms, printMap, busy }) {
  const [edit, setEdit] = useState(null);
  const fileRef = useRef(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="p-4" style={card}>
        <div className="wh-display font-black mb-3">📄 קבצים והדפסה</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <button className="py-3 text-sm font-bold" style={btn(true)} onClick={() => printMap("")}>🖨️ מפת חדרים</button>
          <button className="py-3 text-sm font-bold" style={btn(false)} onClick={printByRooms}>🖨️ סידור לפי חדרים</button>
          <button className="py-3 text-sm font-bold" style={btn(false)} onClick={exportExcel}>⬇️ ייצוא לאקסל</button>
          {canEdit && (
            <button className="py-3 text-sm font-bold" style={btn(false)} disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>⬆️ ייבוא אקסל / וורד</button>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.csv,.docx" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; handleImportFile(f); }} />
        <div className="text-xs mt-3" style={{ color: C.steel }}>
          ייבוא: אקסל עם עמודות "שם" ו"חדר" (וגם גיליון "חדרים" עם מספר מיטות), או וורד בפורמט "חדר 101 - [6]" עם השמות מתחת.
          קובץ וורד עם סיסמה צריך קודם לפתוח בוורד ולהסיר את הסיסמה.
        </div>
      </div>

      <div className="p-4" style={card}>
        <div className="flex items-center justify-between mb-3">
          <div className="wh-display font-black">חדרים ({sortedRooms.length})</div>
          {canEdit && <button className="px-4 py-2 text-sm font-bold" style={btn(true)} onClick={() => setEdit({ num: "", wing: "", beds: 6, notes: "" })}>+ חדר חדש</button>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse", minWidth: 480 }}>
            <thead><tr style={{ color: C.steel }}>
              <th className="text-right py-1">חדר</th><th className="text-right">אגף / קומה</th><th>מיטות</th><th>תפוסים</th><th>מצב</th><th className="text-right">הערות</th><th></th>
            </tr></thead>
            <tbody>
              {sortedRooms.map((r) => {
                const i = roomInfo(r);
                const st = i.free < 0 ? ["חריגה!", "#9C0006", "#FDECEC"] : i.free === 0 ? ["מלא", C.steel, C.paper] : i.taken === 0 ? ["ריק", "#2F6B2A", "#E6F4E2"] : ["יש מקום", "#2F6B2A", "#E6F4E2"];
                return (
                  <tr key={r.id} style={{ borderTop: `1px solid ${C.kraftDark}` }}>
                    <td className="py-1.5 font-black">{r.num}</td>
                    <td>{r.wing || defaultWing(r.num)}</td>
                    <td className="text-center">{i.beds}</td>
                    <td className="text-center">{i.taken}</td>
                    <td className="text-center"><span className="px-2 py-0.5 text-xs font-bold" style={{ borderRadius: 999, color: st[1], background: st[2] }}>{st[0]}</span></td>
                    <td className="text-xs" style={{ color: C.steel }}>{r.notes}</td>
                    <td className="text-left whitespace-nowrap">
                      {canEdit && <>
                        <button className="px-2 text-xs" onClick={() => setEdit({ ...r, oldNum: r.num })}>✏️</button>
                        <button className="px-2 text-xs" onClick={() => deleteRoom(r)}>🗑️</button>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {edit && (
        <Modal C={C} card={card} onClose={() => setEdit(null)}>
          <div className="wh-display font-black text-lg mb-3">{edit.id ? `עריכת חדר ${edit.oldNum}` : "חדר חדש"}</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs" style={{ color: C.steel }}>מספר חדר
              <input type="number" value={edit.num} onChange={(e) => setEdit({ ...edit, num: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input} />
            </label>
            <label className="text-xs" style={{ color: C.steel }}>מיטות
              <input type="number" min="0" value={edit.beds} onChange={(e) => setEdit({ ...edit, beds: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input} />
            </label>
            <label className="text-xs col-span-2" style={{ color: C.steel }}>אגף / קומה
              <input value={edit.wing} onChange={(e) => setEdit({ ...edit, wing: e.target.value })} placeholder={edit.num ? defaultWing(edit.num) : "קומה 1"} className="w-full px-3 py-2 text-sm mt-1" style={input} />
            </label>
            <label className="text-xs col-span-2" style={{ color: C.steel }}>הערות
              <input value={edit.notes || ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input} />
            </label>
          </div>
          <div className="flex gap-2 mt-4">
            <button className="flex-1 py-2.5 text-sm font-bold" style={btn(true)} onClick={async () => { if (await saveRoom(edit)) setEdit(null); }}>שמירה</button>
            <button className="px-4 py-2.5 text-sm" style={btn(false)} onClick={() => setEdit(null)}>ביטול</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function StudentDialog({ C, card, input, btn, student, sortedRooms, roomInfo, canEdit, onClose, onSave, onDelete }) {
  const [f, setF] = useState({
    name: student.name || "",
    room: student.room == null ? "" : String(student.room),
    shiur: student.shiur || "",
    phone: student.phone || "",
    notes: student.notes || "",
  });
  return (
    <Modal C={C} card={card} onClose={onClose}>
      <div className="wh-display font-black text-lg mb-3">{student.name}</div>
      <div className="flex flex-col gap-2">
        <label className="text-xs" style={{ color: C.steel }}>שם
          <input disabled={!canEdit} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input} />
        </label>
        <label className="text-xs" style={{ color: C.steel }}>חדר
          <select disabled={!canEdit} value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input}>
            <option value="">ללא חדר</option>
            {sortedRooms.map((r) => {
              const i = roomInfo(r);
              const mine = String(student.room) === String(r.num);
              const full = i.free <= 0 && !mine;
              return <option key={r.id} value={r.num} disabled={full}>
                {r.num} · {r.wing || defaultWing(r.num)} · {mine ? "החדר הנוכחי" : full ? "מלא" : `${i.free} פנויות`}
              </option>;
            })}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs" style={{ color: C.steel }}>שיעור / שנתון
            <input disabled={!canEdit} value={f.shiur} onChange={(e) => setF({ ...f, shiur: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input} />
          </label>
          <label className="text-xs" style={{ color: C.steel }}>טלפון
            <input disabled={!canEdit} dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input} />
          </label>
        </div>
        <label className="text-xs" style={{ color: C.steel }}>הערות
          <input disabled={!canEdit} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className="w-full px-3 py-2 text-sm mt-1" style={input} />
        </label>
      </div>
      <div className="flex gap-2 mt-4">
        {canEdit && <button className="flex-1 py-2.5 text-sm font-bold" style={btn(true)}
          onClick={() => {
            const name = cleanName(f.name);
            if (!name) return;
            onSave({ name, room: f.room === "" ? null : Number(f.room), shiur: cleanName(f.shiur), phone: cleanName(f.phone), notes: cleanName(f.notes) });
          }}>שמירה</button>}
        <button className="px-4 py-2.5 text-sm" style={btn(false)} onClick={onClose}>סגירה</button>
        {canEdit && <button className="px-4 py-2.5 text-sm font-bold" style={{ ...btn(false), color: "#9C0006" }} onClick={onDelete}>מחיקה</button>}
      </div>
    </Modal>
  );
}

function Modal({ C, card, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(10,15,30,0.45)" }} onClick={onClose}>
      <div className="w-full max-w-md p-5 wh-body" dir="rtl" style={{ ...card, color: C.ink, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
