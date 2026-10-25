"use strict";
/* Soundboard: contenuti cifrati (AES-GCM), mazzi senza ripetizioni, funzionamento offline. */

const $ = (id) => document.getElementById(id);
const DATA = "data/";
const CACHE_DATA = "sb-data";
const LS = "sb.state.v1";
const HOLD_MS = 550;

let meta = null, key = null, catalogo = null, byId = new Map();
let S = caricaStato();
let audio = new Audio(), urlCorrente = null, inRiproduzione = null, ultimaCat = null;
let wakeLock = null;

/* ---------- utilità ---------- */
function caricaStato() {
  try { const s = JSON.parse(localStorage.getItem(LS)); if (s) return Object.assign(base(), s); } catch (e) {}
  return base();
}
function base() { return { decks: {}, hist: [], last: {}, opt: { vib: true, wake: false, text: true }, build: "" }; }
function salva() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} }
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); }
const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function vibra(p) { if (S.opt.vib && navigator.vibrate) navigator.vibrate(p); }

/* ---------- chiave persistente (IndexedDB, non esportabile) ---------- */
function idb() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open("sb", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  });
}
async function kv(op, k, v) {
  const db = await idb();
  return new Promise((ok, ko) => {
    const tx = db.transaction("kv", "readwrite"), st = tx.objectStore("kv");
    const rq = op === "get" ? st.get(k) : op === "put" ? st.put(v, k) : st.delete(k);
    rq.onsuccess = () => ok(rq.result); rq.onerror = () => ko(rq.error);
  });
}

/* ---------- cifratura ---------- */
async function derivaChiave(password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: hex(meta.sale), iterations: meta.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
async function decifra(buf) {
  const b = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12));
}
async function scarica(nome) {
  const cache = await caches.open(CACHE_DATA);
  let r = await cache.match(DATA + nome);
  if (!r) { r = await fetch(DATA + nome); if (!r.ok) throw new Error("rete"); await cache.put(DATA + nome, r.clone()); }
  return r.arrayBuffer();
}

/* ---------- avvio ---------- */
/* ---------- aggiornamenti dell'app ---------- */
let swReg = null, ricaricaAlCambio = false;
function mostraBanner(worker) {
  $("upd").hidden = false;
  $("updBtn").onclick = () => { ricaricaAlCambio = true; worker.postMessage({ type: "SKIP_WAITING" }); };
  $("updX").onclick = () => { $("upd").hidden = true; };
}
function registraSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").then((r) => {
    swReg = r;
    if (r.waiting && navigator.serviceWorker.controller) mostraBanner(r.waiting);
    r.addEventListener("updatefound", () => {
      const w = r.installing;
      w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) mostraBanner(w); });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (ricaricaAlCambio) location.reload(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && swReg) swReg.update().catch(() => {}); });
}
async function controllaAggiornamenti() {
  if (!swReg) { toast("Aggiornamenti non disponibili su questo dispositivo."); return; }
  try {
    await swReg.update();
    await new Promise((r) => setTimeout(r, 1500));
    if (!swReg.installing && !swReg.waiting) toast("Sei già all'ultima versione ✓");
    else $("settings").close();
  } catch (e) { toast("Impossibile controllare: sei offline?"); }
}

async function boot() {
  registraSW();
  try { meta = await (await fetch(DATA + "meta.json", { cache: "no-cache" })).json(); }
  catch (e) { $("lock").hidden = false; $("lockMsg").textContent = "Impossibile caricare i dati. Connettiti almeno la prima volta."; return; }
  key = await kv("get", "key").catch(() => null);
  if (key) {
    try { await apri(); return; } catch (e) { await kv("del", "key").catch(() => {}); key = null; }
  }
  $("lock").hidden = false; $("pw").focus();
}

async function apri() {
  const dati = await decifra(await scarica(meta.catalogo));
  catalogo = JSON.parse(new TextDecoder().decode(dati));
  byId = new Map(catalogo.frasi.map((f) => [f.id, f]));
  S.decks = {}; // il catalogo può essere cambiato: i mazzi si rifanno al primo uso
  $("lock").hidden = true; $("app").hidden = false;
  disegnaGriglia(); disegnaChips(); disegnaLista(); impostazioni();
  precarica();
}

$("lockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("pw").value; if (!pw) return;
  $("unlock").disabled = true; $("lockMsg").textContent = "Verifica in corso…";
  await new Promise((r) => setTimeout(r, 30));
  try {
    key = await derivaChiave(pw);
    await apri();
    if ($("remember").checked) await kv("put", "key", key).catch(() => {});
    $("pw").value = "";
  } catch (err) {
    key = null;
    $("lockMsg").textContent = err && err.name === "OperationError" ? "Password errata." : "Impossibile caricare i dati: controlla la connessione.";
  }
  $("unlock").disabled = false;
});

async function precarica() {
  const cache = await caches.open(CACHE_DATA);
  const attesi = new Set([DATA + meta.catalogo, ...catalogo.frasi.map((f) => DATA + f.file)]);
  for (const rq of await cache.keys()) { const p = new URL(rq.url).pathname; if (![...attesi].some((a) => p.endsWith(a))) cache.delete(rq); }
  const mancanti = [];
  for (const f of catalogo.frasi) if (!(await cache.match(DATA + f.file))) mancanti.push(f.file);
  if (!mancanti.length) { S.build = meta.build; salva(); return; }
  toast(`Scarico gli audio per l'uso offline (${mancanti.length})…`);
  let fatti = 0;
  const lavora = async () => { for (let n; (n = mancanti.pop());) { try { await scarica(n); } catch (e) {} fatti++; } };
  await Promise.all([lavora(), lavora(), lavora(), lavora()]);
  S.build = meta.build; salva();
  toast("Audio pronti anche offline ✓");
}

/* ---------- selezione: mazzo senza reinserimento + penalità per motivi e recenza ---------- */
function pool(k) {
  return k === "CRE" ? catalogo.frasi.filter((f) => f.reg === "C") : catalogo.frasi.filter((f) => f.k === k && f.reg !== "C");
}
function estrai(k) {
  const p = pool(k); if (!p.length) return null;
  const ids = new Set(p.map((f) => f.id));
  let deck = (S.decks[k] || []).filter((id) => ids.has(id));
  if (!deck.length) {
    const recenti = S.hist.slice(-2).map((h) => h.id);
    deck = p.map((f) => f.id).filter((id) => !(p.length > 4 && recenti.includes(id)));
  }
  const motiviRecenti = S.hist.slice(-2).flatMap((h) => (byId.get(h.id) || {}).motivi || []);
  const ora = Date.now();
  const pesi = deck.map((id) => {
    const f = byId.get(id);
    let w = Math.pow(0.3, f.motivi.filter((m) => motiviRecenti.includes(m)).length);
    const t = S.last[id]; if (t) w *= Math.min(1, 0.2 + (ora - t) / 60000 / 30);
    return w;
  });
  let r = Math.random() * pesi.reduce((a, b) => a + b, 0), i = 0;
  while (i < pesi.length - 1 && (r -= pesi[i]) > 0) i++;
  const scelta = deck[i];
  S.decks[k] = deck.filter((_, j) => j !== i);
  return scelta;
}

/* ---------- riproduzione ---------- */
async function riproduci(id, k) {
  const f = byId.get(id); if (!f) return;
  try {
    fermaAudio();
    const dati = await decifra(await scarica(f.file));
    urlCorrente = URL.createObjectURL(new Blob([dati], { type: "audio/mpeg" }));
    const a = audio = new Audio(urlCorrente);
    a.onended = () => { if (audio === a) segnaOn(null); };
    inRiproduzione = id; ultimaCat = k || f.k;
    S.hist.push({ id, t: Date.now() }); S.hist = S.hist.slice(-50); S.last[id] = Date.now(); salva();
    mostraOra(f); segnaOn(id);
    await audio.play();
  } catch (e) { toast("Audio non disponibile. Controlla la connessione."); segnaOn(null); }
}
function fermaAudio() {
  try { audio.pause(); } catch (e) {}
  if (urlCorrente) { URL.revokeObjectURL(urlCorrente); urlCorrente = null; }
}
function segnaOn(id) {
  inRiproduzione = id;
  document.querySelectorAll(".tile.on,.item.on").forEach((e) => e.classList.remove("on"));
  if (!id) return;
  const f = byId.get(id);
  document.querySelectorAll(`[data-k="${ultimaCat}"].tile`).forEach((e) => e.classList.add("on"));
  document.querySelectorAll(`.item[data-id="${f.id}"]`).forEach((e) => e.classList.add("on"));
}
function mostraOra(f) {
  const c = catalogo.categorie.find((x) => x.k === f.k);
  $("nowCat").textContent = c ? c.nome : "";
  $("nowTxt").textContent = S.opt.text ? "«" + f.testo + "»" : "…";
}
function perCategoria(k) { const id = estrai(k); if (id) { vibra(25); riproduci(id, k); } else toast("Nessuna frase in questa categoria."); }

/* ---------- pressione prolungata (Crepa) ---------- */
function holdable(el, azione) {
  let timer = null, fatto = false;
  const inizia = (e) => {
    if (e.button > 0) return; fatto = false; el.classList.add("holding");
    timer = setTimeout(() => { fatto = true; el.classList.remove("holding"); vibra([30, 40, 30]); azione(); }, HOLD_MS);
  };
  const fine = () => {
    clearTimeout(timer); el.classList.remove("holding");
    if (!fatto && timer) toast("Tieni premuto per far cadere la maschera");
    timer = null;
  };
  el.addEventListener("pointerdown", inizia);
  el.addEventListener("pointerup", fine); el.addEventListener("pointercancel", () => { clearTimeout(timer); el.classList.remove("holding"); timer = null; });
  el.addEventListener("pointerleave", () => { clearTimeout(timer); el.classList.remove("holding"); timer = null; });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ---------- interfaccia ---------- */
function disegnaGriglia() {
  const g = $("grid"); g.innerHTML = "";
  for (const c of catalogo.categorie) {
    const b = document.createElement("button");
    b.className = "tile" + (c.k === "CRE" ? " lockd" : ""); b.dataset.k = c.k;
    b.innerHTML = `<span class="holdring"></span><span class="ic"></span><span class="lb"></span>` + (c.k === "CRE" ? "<small>tieni premuto</small>" : "");
    b.querySelector(".ic").textContent = c.icona; b.querySelector(".lb").textContent = c.breve;
    if (c.k === "CRE") holdable(b, () => perCategoria("CRE")); else b.addEventListener("click", () => perCategoria(c.k));
    g.appendChild(b);
  }
}
let filtroCat = "";
function disegnaChips() {
  const el = $("chips"); el.innerHTML = "";
  const mk = (k, nome) => { const b = document.createElement("button"); b.textContent = nome; b.setAttribute("aria-pressed", String(filtroCat === k));
    b.onclick = () => { filtroCat = k; disegnaChips(); disegnaLista(); }; el.appendChild(b); };
  mk("", "Tutte"); for (const c of catalogo.categorie) mk(c.k, c.breve);
}
function disegnaLista() {
  const q = norm($("search").value.trim()), ul = $("list"); ul.innerHTML = "";
  const visti = catalogo.frasi.filter((f) => (!filtroCat || f.k === filtroCat || (filtroCat === "CRE" && f.reg === "C")) && (!q || norm(f.testo).includes(q)));
  if (!visti.length) { ul.innerHTML = '<li class="empty">Nessuna frase trovata.</li>'; return; }
  for (const f of visti) {
    const li = document.createElement("li"); li.className = "item" + (f.reg === "C" ? " c" : ""); li.dataset.id = f.id;
    const cat = catalogo.categorie.find((c) => c.k === f.k);
    li.innerHTML = '<span class="holdring"></span><div class="t"></div><span class="badge"></span>';
    li.querySelector(".t").textContent = f.testo;
    const m = document.createElement("span"); m.className = "meta"; m.textContent = cat ? cat.nome : ""; li.querySelector(".t").appendChild(m);
    li.querySelector(".badge").textContent = f.reg === "C" ? "🔒" : f.reg;
    if (f.reg === "C") holdable(li, () => riproduci(f.id, "CRE")); else li.addEventListener("click", () => { vibra(20); riproduci(f.id, f.k); });
    ul.appendChild(li);
  }
  if (inRiproduzione) segnaOn(inRiproduzione);
}
$("search").addEventListener("input", disegnaLista);

function vista(lib) {
  $("viewScena").hidden = lib; $("viewLib").hidden = !lib;
  $("tabScena").setAttribute("aria-selected", String(!lib)); $("tabLib").setAttribute("aria-selected", String(lib));
}
$("tabScena").onclick = () => vista(false); $("tabLib").onclick = () => vista(true);

$("bStop").onclick = () => { fermaAudio(); segnaOn(null); };
$("bRep").onclick = () => { const u = S.hist[S.hist.length - 1]; if (u) { const f = byId.get(u.id); riproduci(u.id, ultimaCat || f.k); } };
$("bNext").onclick = () => {
  const u = S.hist[S.hist.length - 1]; const k = ultimaCat || (u && byId.get(u.id).k);
  if (k) perCategoria(k); else toast("Scegli prima un contesto.");
};

/* ---------- impostazioni ---------- */
function impostazioni() {
  $("optVib").checked = S.opt.vib; $("optWake").checked = S.opt.wake; $("optText").checked = S.opt.text;
  $("ver").textContent = `Versione ${meta.build} · ${meta.n} frasi`;
  if (S.opt.wake) schermoAcceso(true);
}
$("btnSet").onclick = () => $("settings").showModal();
$("bClose").onclick = () => $("settings").close();
$("bUpd").onclick = controllaAggiornamenti;
$("optVib").onchange = (e) => { S.opt.vib = e.target.checked; salva(); };
$("optText").onchange = (e) => { S.opt.text = e.target.checked; salva(); const u = S.hist[S.hist.length - 1]; if (u) mostraOra(byId.get(u.id)); };
$("optWake").onchange = (e) => { S.opt.wake = e.target.checked; salva(); schermoAcceso(S.opt.wake); };
$("bReset").onclick = () => { S.decks = {}; S.hist = []; S.last = {}; salva(); toast("Storico azzerato"); };
$("bForget").onclick = async () => {
  if (!confirm("Dimenticare la password e cancellare gli audio salvati su questo dispositivo?")) return;
  await kv("del", "key").catch(() => {}); await caches.delete(CACHE_DATA); location.reload();
};
async function schermoAcceso(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { toast("Schermo sempre acceso non supportato."); }
}
document.addEventListener("visibilitychange", () => { if (S.opt.wake && document.visibilityState === "visible") schermoAcceso(true); });

boot();
