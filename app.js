/* ============================================================
   Substation Collection Live Dashboard
   Sections: CONFIG · state/utils · auth · API · loading · metrics · UI · interactive map · polling · bootstrap
   ============================================================ */

/* ---------- CONFIG: edit everything here ---------- */
const CONFIG = {
  serviceUrl: "https://services3.arcgis.com/XEcKZFAaYrAyY47P/arcgis/rest/services/Substation_Infrastructure/FeatureServer",
  portalUrl: "https://www.arcgis.com",
  appId: "aTIU8ad6c2WbScWH",                  // OAuth Client ID
  layerIds: Array.from({ length: 27 }, (_, i) => i),
  substationLayerId: 0, feederLayerId: 26,
  pollSeconds: 15, resyncSeconds: 300, historyDays: 7, concurrency: 6,
  fieldMap: { guidField: "substation_guid", nameField: "substation_name", substationKeyField: "GlobalID", substationNameField: "name" },
  createdDateFields: ["@editTracking", "created_date"],
  createdUserFields: ["@editTracking", "created_user"],
  basemaps: {                                 // switchable in the map toolbar
    dark: "https://tiles.openfreemap.org/styles/dark",
    light: "https://tiles.openfreemap.org/styles/positron",
    sat: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
  },
  barMetersPerFeature: 1500                   // 3D bar height per submission (24 h)
};

/* ---------- State & utils ---------- */
const $ = s => document.querySelector(s);
const S = { meta: {}, subs: new Map(), events: [], seen: new Set(), counts: {}, lastCheck: 0, sort: { k: "count", d: -1 }, token: null, esriId: null,
  timers: [], charts: {}, map: null, mapReady: false, sel: null, feedList: [], feedGeo: { type: "FeatureCollection", features: [] },
  devGeo: { type: "FeatureCollection", features: [] }, devLoaded: false, freshGeo: { type: "FeatureCollection", features: [] },
  vis: { subs: true, feeders: true, heat: true, bars: false, devs: false }, follow: false, measure: false, mpts: [], replay: null, base: "dark" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = g => String(g || "").toLowerCase().replace(/[{}]/g, "");
const fmt = n => Number(n || 0).toLocaleString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tsLit = ms => "timestamp '" + new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "'";
function banner(msg) { const b = $("#banner"); b.textContent = msg; b.hidden = !msg; }

/* ---------- Auth ---------- */
function initAuth() {
  const button = $("#btnLogin"), message = $("#loginMsg"), clientId = CONFIG.appId?.trim();
  if (!clientId) { message.textContent = "Enter your ArcGIS OAuth Client ID in CONFIG.appId."; return; }
  if (typeof window.require !== "function") { message.textContent = "The ArcGIS SDK did not load. Check your connection and reload this page."; return; }
  const fail = error => { console.error("ArcGIS sign-in setup failed", error); message.textContent = "ArcGIS sign-in could not start. Check the OAuth configuration and reload."; };
  const timeout = setTimeout(() => fail(new Error("ArcGIS identity modules timed out")), 15000);
  window.require(["esri/identity/OAuthInfo", "esri/identity/IdentityManager"], (OAuthInfo, esriId) => {
    clearTimeout(timeout);
    try {
      const portal = new URL(CONFIG.portalUrl);
      if (portal.protocol !== "https:") throw new Error("Use an HTTPS ArcGIS portal URL.");
      const portalUrl = portal.href.replace(/\/+$/, ""), sharing = portalUrl + "/sharing";
      esriId.registerOAuthInfos([new OAuthInfo({ appId: clientId, portalUrl, popup: false, flowType: "authorization-code" })]);
      S.esriId = esriId;
      button.onclick = async () => {
        button.disabled = true; message.textContent = "Opening ArcGIS sign-in…";
        try { onSignedIn(await esriId.getCredential(sharing)); }
        catch (error) { message.textContent = "Sign-in failed: " + (error.message || error); button.disabled = false; }
      };
      $("#btnLogout").onclick = () => { esriId.destroyCredentials(); location.reload(); };
      esriId.checkSignInStatus(sharing).then(onSignedIn, () => { message.textContent = ""; button.disabled = false; });
    } catch (error) { fail(error); }
  }, error => { clearTimeout(timeout); fail(error); });
}
function onSignedIn(cred) {
  if (S.token) return;
  S.token = cred.token; S.user = cred.userId;
  $("#login").hidden = true; $("#app").hidden = false;
  $("#user").textContent = (cred.userId || "?")[0].toUpperCase(); $("#user").title = cred.userId;
  start();
}
async function refreshToken() { S.token = (await S.esriId.getCredential(CONFIG.portalUrl + "/sharing", { oAuthPopupConfirmation: false })).token; }

/* ---------- REST API ---------- */
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
async function queryAll(id, params) {
  let off = 0, out = [];
  for (;;) {
    const j = await api(`${id}/query`, { ...params, resultOffset: off, resultRecordCount: 2000 });
    out = out.concat(j.features || []); off += (j.features || []).length;
    if (!j.exceededTransferLimit || !(j.features || []).length) return out;
  }
}
async function pool(items, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: CONFIG.concurrency }, async () => {
    while (i < items.length) { const k = items[i++]; try { res.push(await fn(k)); } catch (e) { console.warn("layer", k, e); banner(`Layer ${k}: ${e.message}`); } }
  }));
  return res;
}

/* ---------- Metadata & loading ---------- */
function pick(fields, cands, eft, key) {
  const names = fields.map(f => f.name);
  for (const c of cands) { const n = c === "@editTracking" ? eft?.[key] : names.find(x => x.toLowerCase() === c.toLowerCase()); if (n && names.includes(n)) return n; }
}
async function loadMeta() {
  await pool(CONFIG.layerIds, async id => {
    const m = await api(`${id}`), f = m.fields || [], ci = n => f.find(x => x.name.toLowerCase() === String(n).toLowerCase())?.name;
    S.meta[id] = { id, name: m.name, geom: m.geometryType, oid: m.objectIdField,
      dateF: pick(f, CONFIG.createdDateFields, m.editFieldsInfo, "creationDateField"),
      userF: pick(f, CONFIG.createdUserFields, m.editFieldsInfo, "creatorField"),
      guidF: ci(CONFIG.fieldMap.guidField), nameF: ci(CONFIG.fieldMap.nameField) };
  });
}
async function loadSubstations() {
  const id = CONFIG.substationLayerId, fm = CONFIG.fieldMap; if (!S.meta[id]) return;
  const feats = await queryAll(id, { where: "1=1", outFields: "*", returnGeometry: true, outSR: 4326 });
  S.subs.clear();
  feats.forEach(ft => { const a = ft.attributes, k = norm(a[fm.substationKeyField]);
    S.subs.set(k, { key: k, name: a[fm.substationNameField] || "Unnamed", x: ft.geometry?.x, y: ft.geometry?.y, a }); });
}
function toEvent(M, a) {
  const key = norm(a[M.guidF]), sub = S.subs.get(key);
  return { t: a[M.dateF], layer: M.id, oid: a[M.oid], user: a[M.userF] || "unknown", subKey: sub ? key : (a[M.nameF] ? "n:" + a[M.nameF] : ""), subName: sub?.name || a[M.nameF] || "" };
}
const outF = M => [M.oid, M.dateF, M.userF, M.guidF, M.nameF].filter(Boolean).join(",");
async function loadHistory() {
  const since = Date.now() - CONFIG.historyDays * 864e5; S.lastCheck = Date.now(); S.events = []; S.seen.clear();
  await pool(CONFIG.layerIds, async id => {
    const M = S.meta[id]; if (!M?.dateF) return;
    const feats = await queryAll(id, { where: `${M.dateF} >= ${tsLit(since)}`, outFields: outF(M), returnGeometry: false });
    feats.forEach(ft => { const e = toEvent(M, ft.attributes); if (e.t) { S.events.push(e); S.seen.add(id + ":" + e.oid); } });
  });
  S.events.sort((a, b) => b.t - a.t);
}
async function loadCounts() { await pool(CONFIG.layerIds, async id => { S.counts[id] = (await api(`${id}/query`, { where: "1=1", returnCountOnly: true })).count; }); }

/* ---------- Polling ---------- */
async function poll() {
  const fresh = [];
  await pool(CONFIG.layerIds, async id => {
    const M = S.meta[id]; if (!M?.dateF) return;
    const feats = await queryAll(id, { where: `${M.dateF} > ${tsLit(S.lastCheck - 60000)}`, outFields: outF(M), returnGeometry: true, outSR: 4326 });
    feats.forEach(ft => { const e = toEvent(M, ft.attributes), k = id + ":" + e.oid;
      if (!e.t || S.seen.has(k)) return; S.seen.add(k); e.geom = ft.geometry; fresh.push(e); S.counts[id] = (S.counts[id] || 0) + 1; });
  });
  if (fresh.length) {
    fresh.sort((a, b) => b.t - a.t); S.events = fresh.concat(S.events); S.lastCheck = Math.max(S.lastCheck, ...fresh.map(e => e.t));
    fresh.forEach(e => { const ll = locOf(e); if (ll) S.freshGeo.features.push({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties: { n: S.meta[e.layer]?.name } }); });
    render(fresh); fresh.slice(0, 15).forEach(pulseAt);
    if (S.follow && fresh[0] && locOf(fresh[0])) S.map?.flyTo({ center: locOf(fresh[0]), zoom: Math.max(S.map.getZoom(), 9), speed: .8 });
  } else render([]);
  banner("");
}

/* ---------- Metrics ---------- */
function metrics() {
  const now = Date.now(), c = ms => S.events.filter(e => e.t >= now - ms).length, d = new Date(); d.setHours(0, 0, 0, 0);
  return { total: Object.values(S.counts).reduce((a, b) => a + b, 0), perMin: c(3e5) / 5, perHr: c(36e5), today: S.events.filter(e => e.t >= d.getTime()).length, last: S.events[0] };
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
  else setKpi("#kLast", "No submissions yet");
  $("#pollInfo").textContent = `updated ${new Date().toLocaleTimeString()} · every ${CONFIG.pollSeconds}s`; $("#pill").classList.remove("off");
  renderFeed(fresh); renderTable(); renderLeaderboard(); renderCharts(); refreshMapData();
}
function renderFeed(fresh) {
  S.feedList = S.events.filter(e => !S.sel || e.subKey === S.sel).slice(0, 40);
  $("#feed").innerHTML = S.feedList.map((e, i) => `<li data-i="${i}" class="${fresh.includes(e) ? "new" : ""}"><b>${esc(S.meta[e.layer]?.name)}</b><small>${esc(e.user)} · ${new Date(e.t).toLocaleString()}${e.subName ? " · " + esc(e.subName) : ""}</small></li>`).join("") || '<li class="muted">Waiting for the first submission…</li>';
}
function renderTable() {
  const d1 = {}, cut = Date.now() - 864e5; S.events.forEach(e => { if (e.t >= cut) d1[e.layer] = (d1[e.layer] || 0) + 1; });
  const rows = CONFIG.layerIds.filter(id => S.meta[id]).map(id => ({ name: S.meta[id].name, count: S.counts[id] || 0, d1: d1[id] || 0 }));
  const { k, d } = S.sort; rows.sort((a, b) => (k === "name" ? a.name.localeCompare(b.name) : a[k] - b[k]) * d);
  $("#tbl tbody").innerHTML = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${fmt(r.count)}</td><td>${fmt(r.d1)}</td></tr>`).join("");
}
function renderLeaderboard() {
  const cut = Date.now() - 864e5, g = new Map();
  S.events.forEach(e => { if (e.t < cut || !e.subKey) return; const o = g.get(e.subKey) || { k: e.subKey, n: e.subName || "Unknown", c: 0 }; o.c++; g.set(e.subKey, o); });
  let rows = [...g.values()], title = "Substation leaderboard (24 h)";
  if (!rows.length) { title = "Device activity (24 h)"; const l = new Map(); S.events.forEach(e => { if (e.t >= cut) l.set(e.layer, (l.get(e.layer) || 0) + 1); }); rows = [...l].map(([id, c]) => ({ n: S.meta[id]?.name, c })); }
  rows.sort((a, b) => b.c - a.c); rows = rows.slice(0, 10); const mx = rows[0]?.c || 1; $("#lbTitle").textContent = title;
  $("#lb").innerHTML = rows.map(r => `<li data-k="${esc(r.k || "")}" style="cursor:${r.k ? "pointer" : "default"}"><span>${esc(r.n)}<div style="width:${Math.max(4, r.c / mx * 100)}%"></div></span><b>${r.c}</b></li>`).join("") || '<li class="muted">No activity in the last 24 hours</li>';
}
function renderCharts() {
  if (typeof window.Chart !== "function") { document.querySelector(".charts").hidden = true; return; }
  const b = buckets();
  const mk = (id, type, labels, data) => {
    const ctx = $("#" + id)?.getContext("2d"); if (!ctx) return;
    if (!S.charts[id]) S.charts[id] = new window.Chart(ctx, { type, data: { labels, datasets: [{ data, borderColor: "#3ee0d0", backgroundColor: type === "bar" ? "#ffb020" : "rgba(62,224,208,.18)", fill: true, tension: .35, borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#8b97b2" }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: "#8b97b2", precision: 0 }, grid: { color: "rgba(255,255,255,.06)" } } } } });
    else { const c = S.charts[id]; c.data.labels = labels; c.data.datasets[0].data = data; c.update(); }
  };
  mk("c24", "line", b.hl, b.h); mk("c7", "bar", b.dl, b.dd);
}

/* ============================================================
   INTERACTIVE MAP (MapLibre GL)
   Click a substation = select + filter feed · click feed/leaderboard row = fly there · search · basemaps ·
   heat · 3D activity bars · feeders (hover/click) · device points (clustered) · follow live · replay · measure
   ============================================================ */
const locOf = e => { const g = e.geom; if (g?.x != null) return [g.x, g.y]; if (g?.paths) return g.paths[0][0]; const s = S.subs.get(e.subKey); return s && Number.isFinite(s.x) ? [s.x, s.y] : null; };
const hav = (a, b) => { const r = x => x * Math.PI / 180, d = r(b[1] - a[1]), l = r(b[0] - a[0]), h = Math.sin(d / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(l / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
function subStats() { const now = Date.now(), r = {}; S.events.forEach(e => { if (!e.subKey) return; const o = r[e.subKey] || (r[e.subKey] = { d: 0, m: 0, w: 0 }); o.w++; if (e.t >= now - 864e5) o.d++; if (e.t >= now - 3e5) o.m++; }); return r; }
function subsGeo() {
  const st = subStats(), pts = [], bars = [];
  S.subs.forEach(s => { if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || Math.abs(s.x) > 180 || Math.abs(s.y) > 90) return;
    const o = st[s.key] || { d: 0, m: 0, w: 0 }, p = { key: s.key, name: s.name, recent: o.d, live: o.m, week: o.w };
    pts.push({ type: "Feature", geometry: { type: "Point", coordinates: [s.x, s.y] }, properties: p });
    const d = .012; bars.push({ type: "Feature", properties: p, geometry: { type: "Polygon", coordinates: [[[s.x - d, s.y - d], [s.x + d, s.y - d], [s.x + d, s.y + d], [s.x - d, s.y + d], [s.x - d, s.y - d]]] } });
  });
  return { pts: { type: "FeatureCollection", features: pts }, bars: { type: "FeatureCollection", features: bars } };
}
function refreshMapData() {
  const m = S.map; if (!S.mapReady || !m.getSource("subs")) return;
  const g = subsGeo(); m.getSource("subs").setData(g.pts); m.getSource("bars").setData(g.bars); m.getSource("fresh")?.setData(S.freshGeo);
}
async function loadBasemap(kind) {
  if (kind === "sat") return { fallback: false, style: { version: 8, sources: { s: { type: "raster", tiles: [CONFIG.basemaps.sat], tileSize: 256, maxzoom: 19 } }, layers: [{ id: "s", type: "raster", source: "s" }] } };
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(CONFIG.basemaps[kind], { signal: ctl.signal }); if (!r.ok) throw new Error("Basemap HTTP " + r.status);
    const style = await r.json(); if (style.version !== 8 || !style.sources || !Array.isArray(style.layers)) throw new Error("Invalid style");
    return { style, fallback: false };
  } catch (e) { console.warn("Basemap unavailable", e); return { fallback: true, style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#101826" } }] } }; }
  finally { clearTimeout(timer); }
}
const devColor = () => { const a = ["match", ["get", "layer"]]; for (let i = 1; i <= 25; i++) a.push(i, `hsl(${(i * 47) % 360},80%,62%)`); a.push("#ccc"); return a; };
const GROUPS = { subs: ["glow", "core", "fresh-dot"], feeders: ["feeder-glow", "feeder-flow", "feeder-hit"], heat: ["heat"], bars: ["bars"], devs: ["dev-cl", "dev-pt"] };
function applyVis() { const m = S.map; Object.entries(GROUPS).forEach(([k, ids]) => ids.forEach(id => m.getLayer(id) && m.setLayoutProperty(id, "visibility", S.vis[k] ? "visible" : "none"))); }
function addLayers() { // runs on every style load (basemap switch re-creates everything)
  const m = S.map, g = subsGeo(), add = (id, data, extra = {}) => m.addSource(id, { type: "geojson", data, ...extra });
  add("feeders", S.feedGeo); add("subs", g.pts); add("bars", g.bars); add("fresh", S.freshGeo); add("sel", { type: "FeatureCollection", features: [] });
  add("devs", S.devGeo, { cluster: true, clusterRadius: 45, clusterMaxZoom: 13 }); add("meas", { type: "FeatureCollection", features: [] });
  const L = x => m.addLayer(x);
  L({ id: "feeder-glow", type: "line", source: "feeders", paint: { "line-color": "#3ee0d0", "line-width": 6, "line-opacity": .12, "line-blur": 4 } });
  L({ id: "feeder-flow", type: "line", source: "feeders", paint: { "line-color": "#3ee0d0", "line-width": 1.8, "line-dasharray": [0, 4, 3] } });
  L({ id: "feeder-hit", type: "line", source: "feeders", paint: { "line-width": 14, "line-opacity": 0 } });
  L({ id: "heat", type: "heatmap", source: "subs", maxzoom: 10, paint: { "heatmap-weight": ["interpolate", ["linear"], ["get", "recent"], 0, .25, 20, 1], "heatmap-radius": 32, "heatmap-opacity": .6, "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", .3, "#1f6f8b", .7, "#ffb020", 1, "#fff2c2"] } });
  L({ id: "bars", type: "fill-extrusion", source: "bars", paint: { "fill-extrusion-height": ["*", ["get", "recent"], CONFIG.barMetersPerFeature], "fill-extrusion-color": ["interpolate", ["linear"], ["get", "recent"], 0, "#1f6f8b", 10, "#ffb020", 30, "#fff2c2"], "fill-extrusion-opacity": .85 } });
  L({ id: "dev-cl", type: "circle", source: "devs", filter: ["has", "point_count"], paint: { "circle-color": ["step", ["get", "point_count"], "#3ee0d0", 50, "#ffb020", 500, "#ff5470"], "circle-radius": ["step", ["get", "point_count"], 12, 50, 17, 500, 24], "circle-opacity": .8, "circle-stroke-width": 1, "circle-stroke-color": "#fff" } });
  L({ id: "dev-pt", type: "circle", source: "devs", filter: ["!", ["has", "point_count"]], paint: { "circle-color": devColor(), "circle-radius": 4, "circle-stroke-width": .8, "circle-stroke-color": "#000" } });
  L({ id: "glow", type: "circle", source: "subs", paint: { "circle-radius": 12, "circle-color": ["case", [">", ["get", "live"], 0], "#3ee0d0", "#ffb020"], "circle-opacity": .25, "circle-blur": 1 } });
  L({ id: "core", type: "circle", source: "subs", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "recent"], 0, 4.5, 50, 12], "circle-color": ["case", [">", ["get", "recent"], 0], "#ffb020", "#7a88a8"], "circle-stroke-color": ["case", [">", ["get", "live"], 0], "#3ee0d0", "#fff"], "circle-stroke-width": ["case", [">", ["get", "live"], 0], 2.5, 1] } });
  L({ id: "fresh-dot", type: "circle", source: "fresh", paint: { "circle-radius": 5, "circle-color": "#ff5470", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  L({ id: "sel-ring", type: "circle", source: "sel", paint: { "circle-radius": 20, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
  L({ id: "meas-line", type: "line", source: "meas", filter: ["==", "$type", "LineString"], paint: { "line-color": "#fff", "line-width": 2, "line-dasharray": [2, 2] } });
  L({ id: "meas-pt", type: "circle", source: "meas", filter: ["==", "$type", "Point"], paint: { "circle-radius": 5, "circle-color": "#fff" } });
  applyVis(); setSel(S.sel, false);
}
function setSel(key, fly) {
  S.sel = key || null; const m = S.map, s = key && S.subs.get(key);
  m?.getSource("sel")?.setData({ type: "FeatureCollection", features: s && Number.isFinite(s.x) ? [{ type: "Feature", geometry: { type: "Point", coordinates: [s.x, s.y] }, properties: {} }] : [] });
  $("#bClear").hidden = !S.sel; if (fly && s && Number.isFinite(s.x)) m.flyTo({ center: [s.x, s.y], zoom: Math.max(m.getZoom(), 11), speed: .9 });
  renderFeed([]);
  if (s) { const mine = S.events.filter(x => x.subKey === key), by = {}; mine.forEach(x => { const n = S.meta[x.layer]?.name; by[n] = (by[n] || 0) + 1; });
    if (fly !== false) new maplibregl.Popup({ offset: 16 }).setLngLat([s.x, s.y]).setHTML(`<b>${esc(s.name)}</b><br>${mine.length} submissions (${CONFIG.historyDays} d)<br>${Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${esc(k)}: ${v}`).join("<br>") || "No recent activity"}`).addTo(m); }
}
async function loadDevices() {
  if (S.devLoaded) return; S.devLoaded = true; const note = $("#mapNote"), feats = []; let n = 0;
  const ids = CONFIG.layerIds.filter(i => i !== CONFIG.substationLayerId && i !== CONFIG.feederLayerId && S.meta[i]);
  await pool(ids, async id => { const r = await queryAll(id, { where: "1=1", outFields: S.meta[id].oid, returnGeometry: true, outSR: 4326 });
    r.forEach(f => { if (Number.isFinite(f.geometry?.x)) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [f.geometry.x, f.geometry.y] }, properties: { layer: id, lname: S.meta[id].name } }); });
    note.textContent = `Loading devices… ${++n}/${ids.length} layers`; });
  S.devGeo = { type: "FeatureCollection", features: feats }; S.map.getSource("devs")?.setData(S.devGeo); note.textContent = `${fmt(feats.length)} devices mapped`;
}
function pulseAt(e) {
  if (!S.mapReady) return; const ll = locOf(e); if (!ll) return;
  const el = document.createElement("div"); el.className = "pulse"; const mk = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(S.map); setTimeout(() => mk.remove(), 2600);
}
function startReplay() {
  if (S.replay) { clearInterval(S.replay); S.replay = null; $("#bReplay").classList.remove("on"); $("#mapNote").textContent = "Replay stopped"; return; }
  const list = S.events.filter(e => e.t >= Date.now() - 864e5 && locOf(e)).sort((a, b) => a.t - b.t); if (!list.length) { $("#mapNote").textContent = "No located activity in the last 24 h"; return; }
  let i = 0; $("#bReplay").classList.add("on");
  S.replay = setInterval(() => { if (i >= list.length) { startReplay(); return; } const e = list[i++]; pulseAt(e); $("#mapNote").textContent = `Replay ${new Date(e.t).toLocaleTimeString()} · ${S.meta[e.layer]?.name} (${i}/${list.length})`; }, 140);
}
function bindUi() {
  const m = S.map, $$ = s => document.querySelectorAll(s);
  $$(".mtools [data-v]").forEach(c => c.onchange = () => { S.vis[c.dataset.v] = c.checked; applyVis(); if (c.dataset.v === "devs" && c.checked) loadDevices(); if (c.dataset.v === "bars" && c.checked) m.easeTo({ pitch: 55, duration: 800 }); });
  $("#baseSel").onchange = async e => { const { style } = await loadBasemap(e.target.value); m.setStyle(style); };
  $("#bFit").onclick = fitAll; $("#bClear").onclick = () => setSel(null);
  $("#b3d").onclick = () => { const on = m.getPitch() < 10; m.easeTo({ pitch: on ? 60 : 0, bearing: on ? -20 : 0, duration: 900 }); };
  $("#bFollow").onclick = e => { S.follow = !S.follow; e.target.classList.toggle("on", S.follow); };
  $("#bReplay").onclick = startReplay;
  $("#bMeasure").onclick = e => { S.measure = !S.measure; S.mpts = []; e.target.classList.toggle("on", S.measure); m.getSource("meas").setData({ type: "FeatureCollection", features: [] }); m.getCanvas().style.cursor = S.measure ? "crosshair" : ""; $("#mapNote").textContent = S.measure ? "Click the map to measure distance" : "Live collection map"; };
  $("#mapSearch").onchange = e => { const s = [...S.subs.values()].find(x => x.name.toLowerCase() === e.target.value.trim().toLowerCase()) || [...S.subs.values()].find(x => x.name.toLowerCase().includes(e.target.value.trim().toLowerCase())); if (s) setSel(s.key, true); };
  $("#feed").onclick = ev => { const li = ev.target.closest("li[data-i]"), e = li && S.feedList[li.dataset.i], ll = e && locOf(e); if (ll) { m.flyTo({ center: ll, zoom: 12, speed: .9 }); pulseAt(e); } };
  $("#lb").onclick = ev => { const li = ev.target.closest("li[data-k]"); if (li?.dataset.k) setSel(li.dataset.k, true); };
  document.addEventListener("keydown", e => { if (e.key === "Escape") { setSel(null); if (S.measure) $("#bMeasure").click(); } });
}
function fitAll() {
  const m = S.map, b = new maplibregl.LngLatBounds(); S.subs.forEach(s => Number.isFinite(s.x) && Math.abs(s.x) <= 180 && b.extend([s.x, s.y]));
  if (b.isEmpty()) S.feedGeo.features.forEach(f => f.geometry.coordinates.forEach(p => p.forEach(pt => b.extend(pt)))); if (!b.isEmpty()) m.fitBounds(b, { padding: 60, maxZoom: 9, pitch: 0, bearing: 0 });
}
async function initMap() {
  const note = $("#mapNote"); if (typeof maplibregl === "undefined") { note.textContent = "Map library could not load"; return; }
  note.textContent = "Loading map…";
  try {
    const { style, fallback } = await loadBasemap("dark"); const m = S.map = new maplibregl.Map({ container: "map", center: [39.5, 9], zoom: 5, style, maxPitch: 75 });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right"); m.addControl(new maplibregl.ScaleControl(), "bottom-left");
    m.addControl(new maplibregl.FullscreenControl(), "top-right"); m.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
    try { const fs = await queryAll(CONFIG.feederLayerId, { where: "1=1", outFields: "OBJECTID,name,voltage_kv,length_km", returnGeometry: true, outSR: 4326, maxAllowableOffset: 0.001 });
      S.feedGeo.features = fs.filter(f => f.geometry?.paths).map(f => ({ type: "Feature", properties: f.attributes, geometry: { type: "MultiLineString", coordinates: f.geometry.paths } })); } catch (e) { console.warn("feeders", e); }
    $("#subList").innerHTML = [...S.subs.values()].map(s => `<option value="${esc(s.name)}">`).join("");
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("Map style did not initialise")), 12000); m.once("style.load", () => { clearTimeout(t); res(); }); });
    m.on("style.load", () => { if (S.mapReady) addLayers(); });
    addLayers(); S.mapReady = true; bindUi(); fitAll();
    const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 }), over = (id, fn) => { m.on("mousemove", id, e => { if (S.measure) return; m.getCanvas().style.cursor = "pointer"; tip.setLngLat(e.lngLat).setHTML(fn(e.features[0].properties)).addTo(m); }); m.on("mouseleave", id, () => { if (!S.measure) m.getCanvas().style.cursor = ""; tip.remove(); }); };
    over("core", p => `<b>${esc(p.name)}</b><br>${p.recent} in 24 h · ${p.live} in last 5 min`); over("feeder-hit", p => `<b>${esc(p.name || "Feeder")}</b><br>${p.voltage_kv ? p.voltage_kv + " kV · " : ""}${p.length_km ? Number(p.length_km).toFixed(1) + " km" : ""}`);
    over("dev-pt", p => `<b>${esc(p.lname)}</b>`);
    m.on("click", "core", e => { if (!S.measure) setSel(e.features[0].properties.key, true); });
    m.on("click", "dev-cl", e => { const f = e.features[0]; m.getSource("devs").getClusterExpansionZoom(f.properties.cluster_id).then(z => m.easeTo({ center: f.geometry.coordinates, zoom: z + .5 })); });
    m.on("click", e => { if (S.measure) { S.mpts.push([e.lngLat.lng, e.lngLat.lat]); let km = 0; S.mpts.forEach((p, i) => { if (i) km += hav(S.mpts[i - 1], p); });
      m.getSource("meas").setData({ type: "FeatureCollection", features: [...S.mpts.map(c => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } })), ...(S.mpts.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: S.mpts } }] : [])] });
      note.textContent = `Distance: ${km.toFixed(2)} km (${S.mpts.length} points · Esc to stop)`; } });
    m.on("mousemove", e => { $("#coord").textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`; });
    const seq = [[0, 4, 3], [.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, .5], [3, 4, 0], [0, .5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, .5]];
    let step = 0, last = 0;
    (function anim(ts) { if (ts - last > 90) { last = ts; step = (step + 1) % seq.length;
      if (m.getLayer("feeder-flow")) m.setPaintProperty("feeder-flow", "line-dasharray", seq[step]);
      if (m.getLayer("glow")) m.setPaintProperty("glow", "circle-radius", ["+", 12 + 4 * Math.sin(ts / 350), ["*", ["get", "live"], 3]]); } requestAnimationFrame(anim); })(0);
    note.textContent = `${S.subs.size} substations · ${S.feedGeo.features.length} feeders${fallback ? " · basemap unavailable" : ""}`;
  } catch (e) { console.warn("map", e); S.map?.remove(); S.map = null; S.mapReady = false; note.textContent = "Map could not start · metrics remain available"; }
}

/* ---------- Bootstrap ---------- */
async function fullSync() { try { await loadSubstations(); await Promise.all([loadHistory(), loadCounts()]); render(); } catch (e) { banner("Sync problem: " + e.message); $("#pill").classList.add("off"); } }
async function start() {
  document.querySelectorAll("th[data-k]").forEach(th => th.onclick = () => { const k = th.dataset.k; S.sort = { k, d: S.sort.k === k ? -S.sort.d : (k === "name" ? 1 : -1) }; renderTable(); });
  try { await loadMeta(); await fullSync(); } catch (e) { banner("Startup failed: " + e.message); }
  initMap();
  S.timers.push(setInterval(() => poll().catch(e => { banner("Poll failed, retrying: " + e.message); $("#pill").classList.add("off"); }), CONFIG.pollSeconds * 1000));
  S.timers.push(setInterval(fullSync, CONFIG.resyncSeconds * 1000));
}
window.addEventListener("DOMContentLoaded", initAuth);
