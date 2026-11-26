/* ============================================================
   Substation Collection Live Dashboard
   Sections: CONFIG · state/utils · auth · API · loading · metrics · UI · map · polling · bootstrap
   ============================================================ */

/* ---------- CONFIG: edit everything here ---------- */
const CONFIG = {
  // FeatureServer base URL (no trailing slash, no layer id)
  serviceUrl: "https://services3.arcgis.com/XEcKZFAaYrAyY47P/arcgis/rest/services/Substation_Infrastructure/FeatureServer",
  portalUrl: "https://www.arcgis.com",       // ArcGIS Online or your Enterprise portal
  appId: "aTIU8ad6c2WbScWH",          // Client ID of an OAuth app item; add this page's URL as a redirect URI
  layerIds: Array.from({ length: 27 }, (_, i) => i), // 0..26
  substationLayerId: 0,                       // layer holding substation points
  feederLayerId: 26,                          // layer holding feeder polylines
  pollSeconds: 15,                            // incremental poll interval
  resyncSeconds: 300,                         // full count + history re-sync (corrects drift)
  historyDays: 7,                             // history loaded for rates / trend charts
  concurrency: 6,                             // parallel REST requests
  // Link device layers to substations. Matching is case-insensitive per layer.
  // If a layer lacks guidField the app falls back to nameField, then to device-level activity.
  fieldMap: {
    guidField: "substation_guid",             // field on device layers
    nameField: "substation_name",             // fallback name field on device layers
    substationKeyField: "GlobalID",           // key on the substation layer that guidField points to
    substationNameField: "name"               // display name on the substation layer
  },
  // Which fields mean "created". Tried in order per layer; first one that exists wins.
  // "@editTracking" = the layer's editFieldsInfo creator/creation fields (system maintained, most reliable).
  createdDateFields: ["@editTracking", "created_date"],
  createdUserFields: ["@editTracking", "created_user"],
  basemapTiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"]
};

/* ---------- State & utils ---------- */
const $ = s => document.querySelector(s);
const S = { meta: {}, subs: new Map(), events: [], seen: new Set(), counts: {}, lastCheck: 0,
            sort: { k: "count", d: -1 }, token: null, esriId: null, timers: [], charts: {}, map: null, mapReady: false };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = g => String(g || "").toLowerCase().replace(/[{}]/g, "");
const fmt = n => Number(n || 0).toLocaleString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tsLit = ms => "timestamp '" + new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "'";
function banner(msg) { const b = $("#banner"); b.textContent = msg; b.hidden = !msg; }

/* ---------- Auth (ArcGIS Maps SDK identity + OAuth 2.0) ---------- */
function initAuth() {
  if (typeof require === "undefined") { $("#loginMsg").textContent = "ArcGIS SDK failed to load (CDN blocked)."; return; }
  require(["esri/identity/OAuthInfo", "esri/identity/IdentityManager"], (OAuthInfo, esriId) => {
    S.esriId = esriId;
    const info = new OAuthInfo({ appId: CONFIG.appId, portalUrl: CONFIG.portalUrl, popup: false, flowType: "authorization-code" });
    esriId.registerOAuthInfos([info]);
    $("#btnLogin").onclick = () => signIn();
    $("#btnLogout").onclick = () => { esriId.destroyCredentials(); location.reload(); };
    esriId.checkSignInStatus(CONFIG.portalUrl + "/sharing").then(onSignedIn).catch(() => { $("#login").hidden = false; });
  });
}
function signIn() { S.esriId.getCredential(CONFIG.portalUrl + "/sharing").then(onSignedIn).catch(e => $("#loginMsg").textContent = "Sign-in failed: " + (e.message || e)); }
function onSignedIn(cred) {
  S.token = cred.token; S.user = cred.userId;
  $("#login").hidden = true; $("#app").hidden = false;
  $("#user").textContent = (cred.userId || "?")[0].toUpperCase(); $("#user").title = cred.userId;
  start();
}
async function refreshToken() { // silent renewal; SDK re-issues the token if the session is alive
  const c = await S.esriId.getCredential(CONFIG.portalUrl + "/sharing", { oAuthPopupConfirmation: false });
  S.token = c.token;
}

/* ---------- REST API with retry / backoff / token refresh ---------- */
async function api(path, params = {}, tries = 4) {
  const body = new URLSearchParams({ f: "json", ...params, token: S.token });
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${CONFIG.serviceUrl}/${path}`, { method: "POST", body });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.error) {
        if ([498, 499].includes(j.error.code)) { await refreshToken(); body.set("token", S.token); continue; }
        throw new Error(j.error.message || "API error " + j.error.code);
      }
      return j;
    } catch (e) { if (i === tries - 1) throw e; await sleep(600 * 2 ** i); }
  }
}
async function queryAll(id, params) { // handles exceededTransferLimit pagination
  let off = 0, out = [];
  for (;;) {
    const j = await api(`${id}/query`, { ...params, resultOffset: off, resultRecordCount: 2000 });
    out = out.concat(j.features || []); off += (j.features || []).length;
    if (!j.exceededTransferLimit || !(j.features || []).length) return out;
  }
}
async function pool(items, fn) { // limited concurrency, failures isolated per item
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: CONFIG.concurrency }, async () => {
    while (i < items.length) { const k = items[i++]; try { res.push(await fn(k)); } catch (e) { console.warn("layer", k, e); banner(`Layer ${k}: ${e.message}`); } }
  }));
  return res;
}

/* ---------- Layer metadata (fields discovered dynamically) ---------- */
function pick(fields, cands, eft, key) {
  const names = fields.map(f => f.name);
  for (const c of cands) {
    const n = c === "@editTracking" ? eft?.[key] : names.find(x => x.toLowerCase() === c.toLowerCase());
    if (n && names.includes(n)) return n;
  }
}
async function loadMeta() {
  await pool(CONFIG.layerIds, async id => {
    const m = await api(`${id}`);
    const f = m.fields || [], ci = n => f.find(x => x.name.toLowerCase() === String(n).toLowerCase())?.name;
    S.meta[id] = { id, name: m.name, geom: m.geometryType, oid: m.objectIdField,
      dateF: pick(f, CONFIG.createdDateFields, m.editFieldsInfo, "creationDateField"),
      userF: pick(f, CONFIG.createdUserFields, m.editFieldsInfo, "creatorField"),
      guidF: ci(CONFIG.fieldMap.guidField), nameF: ci(CONFIG.fieldMap.nameField) };
  });
}
async function loadSubstations() {
  const id = CONFIG.substationLayerId, M = S.meta[id], fm = CONFIG.fieldMap;
  if (!M) return;
  const feats = await queryAll(id, { where: "1=1", outFields: "*", returnGeometry: true, outSR: 4326 });
  S.subs.clear();
  feats.forEach(ft => {
    const a = ft.attributes, k = norm(a[fm.substationKeyField]);
    S.subs.set(k, { key: k, name: a[fm.substationNameField] || "Unnamed", x: ft.geometry?.x, y: ft.geometry?.y });
  });
}

/* ---------- Data loading ---------- */
function toEvent(M, a) {
  const key = norm(a[M.guidF]), sub = S.subs.get(key);
  return { t: a[M.dateF], layer: M.id, oid: a[M.oid], user: a[M.userF] || "unknown",
           subKey: sub ? key : (a[M.nameF] ? "n:" + a[M.nameF] : ""), subName: sub?.name || a[M.nameF] || "" };
}
async function loadHistory() {
  const since = Date.now() - CONFIG.historyDays * 864e5; S.lastCheck = Date.now();
  S.events = []; S.seen.clear();
  await pool(CONFIG.layerIds, async id => {
    const M = S.meta[id]; if (!M?.dateF) return;
    const out = [M.oid, M.dateF, M.userF, M.guidF, M.nameF].filter(Boolean).join(",");
    const feats = await queryAll(id, { where: `${M.dateF} >= ${tsLit(since)}`, outFields: out, returnGeometry: false });
    feats.forEach(ft => { const e = toEvent(M, ft.attributes); if (e.t) { S.events.push(e); S.seen.add(id + ":" + e.oid); } });
  });
  S.events.sort((a, b) => b.t - a.t);
}
async function loadCounts() {
  await pool(CONFIG.layerIds, async id => { S.counts[id] = (await api(`${id}/query`, { where: "1=1", returnCountOnly: true })).count; });
}

/* ---------- Incremental polling ---------- */
async function poll() {
  const fresh = [];
  await pool(CONFIG.layerIds, async id => {
    const M = S.meta[id]; if (!M?.dateF) return;
    const out = [M.oid, M.dateF, M.userF, M.guidF, M.nameF].filter(Boolean).join(",");
    const feats = await queryAll(id, { where: `${M.dateF} > ${tsLit(S.lastCheck - 60000)}`, outFields: out, returnGeometry: true, outSR: 4326 });
    feats.forEach(ft => {
      const e = toEvent(M, ft.attributes), k = id + ":" + e.oid;
      if (!e.t || S.seen.has(k)) return;
      S.seen.add(k); e.geom = ft.geometry; fresh.push(e); S.counts[id] = (S.counts[id] || 0) + 1;
    });
  });
  if (fresh.length) {
    fresh.sort((a, b) => b.t - a.t); S.events = fresh.concat(S.events);
    S.lastCheck = Math.max(S.lastCheck, ...fresh.map(e => e.t));
    render(fresh); fresh.slice(0, 15).forEach(pulseAt);
  } else render([]);
  banner("");
}

/* ---------- Metrics ---------- */
function metrics() {
  const now = Date.now(), c = ms => S.events.filter(e => e.t >= now - ms).length, d = new Date(); d.setHours(0, 0, 0, 0);
  return { total: Object.values(S.counts).reduce((a, b) => a + b, 0), perMin: c(3e5) / 5, perHr: c(36e5),
           today: S.events.filter(e => e.t >= d.getTime()).length, last: S.events[0] };
}
function buckets() {
  const now = Date.now(), h = Array(24).fill(0), dd = Array(7).fill(0);
  S.events.forEach(e => { const hi = Math.floor((now - e.t) / 36e5), di = Math.floor((now - e.t) / 864e5); if (hi < 24) h[23 - hi]++; if (di < 7) dd[6 - di]++; });
  return { h, dd, hl: h.map((_, i) => new Date(now - (23 - i) * 36e5).getHours() + ":00"), dl: dd.map((_, i) => new Date(now - (6 - i) * 864e5).toLocaleDateString(undefined, { weekday: "short" })) };
}

/* ---------- UI ---------- */
function setKpi(id, v) { const el = $(id); el.classList.remove("sk"); if (el.textContent !== v) { el.textContent = v; const k = el.parentElement; k.classList.remove("flash"); void k.offsetWidth; k.classList.add("flash"); } }
function render(fresh = []) {
  const m = metrics();
  setKpi("#kTotal", fmt(m.total)); setKpi("#kMin", m.perMin.toFixed(1)); setKpi("#kHr", fmt(m.perHr)); setKpi("#kDay", fmt(m.today));
  if (m.last) { setKpi("#kLast", `${S.meta[m.last.layer]?.name} · ${m.last.user}`); $("#kLastSub").textContent = new Date(m.last.t).toLocaleString() + (m.last.subName ? " · " + m.last.subName : ""); }
  else { setKpi("#kLast", "No submissions yet"); }
  $("#pollInfo").textContent = `updated ${new Date().toLocaleTimeString()} · every ${CONFIG.pollSeconds}s`; $("#pill").classList.remove("off");
  renderFeed(fresh); renderTable(); renderLeaderboard(); renderCharts();
}
function renderFeed(fresh) {
  const ul = $("#feed"), li = e => `<li class="${fresh.includes(e) ? "new" : ""}"><b>${esc(S.meta[e.layer]?.name)}</b><small>${esc(e.user)} · ${new Date(e.t).toLocaleString()}${e.subName ? " · " + esc(e.subName) : ""}</small></li>`;
  ul.innerHTML = S.events.slice(0, 40).map(li).join("") || '<li class="muted">Waiting for the first submission…</li>';
}
function renderTable() {
  const d1 = {}; const cut = Date.now() - 864e5; S.events.forEach(e => { if (e.t >= cut) d1[e.layer] = (d1[e.layer] || 0) + 1; });
  const rows = CONFIG.layerIds.filter(id => S.meta[id]).map(id => ({ name: S.meta[id].name, count: S.counts[id] || 0, d1: d1[id] || 0 }));
  const { k, d } = S.sort; rows.sort((a, b) => (k === "name" ? a.name.localeCompare(b.name) : a[k] - b[k]) * d);
  $("#tbl tbody").innerHTML = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${fmt(r.count)}</td><td>${fmt(r.d1)}</td></tr>`).join("");
}
function renderLeaderboard() {
  const cut = Date.now() - 864e5, g = new Map(); let linked = 0;
  S.events.forEach(e => { if (e.t < cut) return; if (e.subKey) { linked++; const o = g.get(e.subKey) || { n: e.subName || "Unknown", c: 0 }; o.c++; g.set(e.subKey, o); } });
  let rows = [...g.values()], title = "Substation leaderboard (24 h)";
  if (!rows.length) { // graceful fallback: device-level activity
    title = "Device activity (24 h)"; const l = new Map();
    S.events.forEach(e => { if (e.t >= cut) l.set(e.layer, (l.get(e.layer) || 0) + 1); });
    rows = [...l].map(([id, c]) => ({ n: S.meta[id]?.name, c }));
  }
  rows.sort((a, b) => b.c - a.c); rows = rows.slice(0, 10); const mx = rows[0]?.c || 1;
  $("#lbTitle").textContent = title;
  $("#lb").innerHTML = rows.map(r => `<li><span>${esc(r.n)}<div style="width:${Math.max(4, r.c / mx * 100)}%"></div></span><b>${r.c}</b></li>`).join("") || '<li class="muted">No activity in the last 24 hours</li>';
}
function renderCharts() {
  if (typeof Chart === "undefined") { document.querySelector(".charts").hidden = true; return; }
  const b = buckets();
  const mk = (id, type, labels, data) => {
    if (!S.charts[id]) S.charts[id] = new Chart($("#" + id), { type, data: { labels, datasets: [{ data, borderColor: "#3ee0d0", backgroundColor: type === "bar" ? "#ffb020" : "rgba(62,224,208,.18)", fill: true, tension: .35, borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#8b97b2" }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: "#8b97b2", precision: 0 }, grid: { color: "rgba(255,255,255,.06)" } } } } });
    else { const c = S.charts[id]; c.data.labels = labels; c.data.datasets[0].data = data; c.update(); }
  };
  mk("c24", "line", b.hl, b.h); mk("c7", "bar", b.dl, b.dd);
}

/* ---------- Map (MapLibre GL; lazy-loaded after KPIs, hidden if the library failed) ---------- */
async function initMap() {
  if (typeof maplibregl === "undefined") { document.querySelector(".mapwrap").hidden = true; return; }
  try {
    const map = S.map = new maplibregl.Map({ container: "map", center: [39.5, 9], zoom: 5,
      style: { version: 8, sources: { b: { type: "raster", tiles: CONFIG.basemapTiles, tileSize: 256 } }, layers: [{ id: "b", type: "raster", source: "b" }] } });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    await new Promise(r => map.on("load", r));
    const pts = { type: "FeatureCollection", features: [...S.subs.values()].filter(s => s.x != null).map(s => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.x, s.y] }, properties: { key: s.key, name: s.name } })) };
    let lines = { type: "FeatureCollection", features: [] };
    try {
      const fs = await queryAll(CONFIG.feederLayerId, { where: "1=1", outFields: "OBJECTID", returnGeometry: true, outSR: 4326, maxAllowableOffset: 0.001 });
      lines.features = fs.filter(f => f.geometry?.paths).map(f => ({ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: f.geometry.paths } }));
    } catch (e) { console.warn("feeders", e); }
    map.addSource("feeders", { type: "geojson", data: lines }); map.addSource("subs", { type: "geojson", data: pts });
    map.addLayer({ id: "feeder-glow", type: "line", source: "feeders", paint: { "line-color": "#3ee0d0", "line-width": 5, "line-opacity": .12, "line-blur": 4 } });
    map.addLayer({ id: "feeder-flow", type: "line", source: "feeders", paint: { "line-color": "#3ee0d0", "line-width": 1.6, "line-dasharray": [0, 4, 3] } });
    map.addLayer({ id: "heat", type: "heatmap", source: "subs", maxzoom: 9, paint: { "heatmap-radius": 28, "heatmap-opacity": .55, "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", .3, "#1f6f8b", .7, "#ffb020", 1, "#fff2c2"] } });
    map.addLayer({ id: "glow", type: "circle", source: "subs", paint: { "circle-radius": 12, "circle-color": "#ffb020", "circle-opacity": .22, "circle-blur": 1 } });
    map.addLayer({ id: "core", type: "circle", source: "subs", paint: { "circle-radius": 4.5, "circle-color": "#ffb020", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
    // animated dashed flow along feeders
    const seq = [[0, 4, 3], [.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, .5], [3, 4, 0], [0, .5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, .5]];
    let step = 0, last = 0;
    (function anim(ts) { if (ts - last > 90) { last = ts; step = (step + 1) % seq.length; map.setPaintProperty("feeder-flow", "line-dasharray", seq[step]); } requestAnimationFrame(anim); })(0);
    // hover tooltip + click popup with device counts
    const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
    map.on("mousemove", "core", e => { map.getCanvas().style.cursor = "pointer"; tip.setLngLat(e.lngLat).setHTML(esc(e.features[0].properties.name)).addTo(map); });
    map.on("mouseleave", "core", () => { map.getCanvas().style.cursor = ""; tip.remove(); });
    map.on("click", "core", e => {
      const p = e.features[0].properties, mine = S.events.filter(x => x.subKey === p.key), by = {};
      mine.forEach(x => by[S.meta[x.layer]?.name] = (by[S.meta[x.layer]?.name] || 0) + 1);
      new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>${esc(p.name)}</b><br>${mine.length} submissions (${CONFIG.historyDays} d)<br>` +
        Object.entries(by).slice(0, 8).map(([k, v]) => `${esc(k)}: ${v}`).join("<br>")).addTo(map);
    });
    if (pts.features.length > 1) { const b = new maplibregl.LngLatBounds(); pts.features.forEach(f => b.extend(f.geometry.coordinates)); map.fitBounds(b, { padding: 50, maxZoom: 9 }); }
    S.mapReady = true;
  } catch (e) { console.warn("map", e); document.querySelector(".mapwrap").hidden = true; }
}
function pulseAt(e) { // expanding ring where a new feature landed
  if (!S.mapReady) return;
  let ll = null; const g = e.geom;
  if (g?.x != null) ll = [g.x, g.y]; else if (g?.paths) ll = g.paths[0][0];
  else if (e.subKey && S.subs.get(e.subKey)) { const s = S.subs.get(e.subKey); ll = [s.x, s.y]; }
  if (!ll) return;
  const el = document.createElement("div"); el.className = "pulse";
  const mk = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(S.map); setTimeout(() => mk.remove(), 2600);
}

/* ---------- Bootstrap ---------- */
async function fullSync() {
  try { await loadSubstations(); await Promise.all([loadHistory(), loadCounts()]); render(); }
  catch (e) { banner("Sync problem: " + e.message); $("#pill").classList.add("off"); }
}
async function start() {
  document.querySelectorAll("th[data-k]").forEach(th => th.onclick = () => {
    const k = th.dataset.k; S.sort = { k, d: S.sort.k === k ? -S.sort.d : (k === "name" ? 1 : -1) }; renderTable();
  });
  try { await loadMeta(); await fullSync(); } catch (e) { banner("Startup failed: " + e.message); }
  initMap();                                    // lazy: after KPI cards have rendered
  S.timers.push(setInterval(() => poll().catch(e => { banner("Poll failed, retrying: " + e.message); $("#pill").classList.add("off"); }), CONFIG.pollSeconds * 1000));
  S.timers.push(setInterval(fullSync, CONFIG.resyncSeconds * 1000));
}
window.addEventListener("load", initAuth);
