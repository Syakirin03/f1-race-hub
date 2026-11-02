/* ============================================================
   F1 Race Hub — live results, season, standings & driver data
   Data: the local SQLite database via server.py (/api/f1), or the
   Jolpica F1 API (https://api.jolpi.ca/ergast/f1) as a fallback.
   Both speak the same Ergast JSON shape.
   ============================================================ */
"use strict";

const LIVE_API = "https://api.jolpi.ca/ergast/f1";
const LOCAL_API = "api/f1";    // relative: server.py locally, or the exported files in production
let API = LIVE_API;
let PAGE = 100;                // the live API's page size; our own data returns everything at once
let DATA = { mode: "live" };   // live | local (server.py + SQLite) | static (published export)
const TODAY = new Date();

/* The drivers' champion. Set `confirmed` once the title is mathematically decided:
   the "<season> Champion" page and its sidebar link appear only while this is true,
   and only for this season, so they hide themselves when the next season starts.
   The champion is whoever leads the standings. */
const CHAMPION = { season: "2026", confirmed: true };

/* ---- tiny request cache so navigation stays snappy & kind to rate limits ---- */
const cache = new Map();
async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(`${API}/${path}`, { headers: { Accept: "application/json" } })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return r.json();
    })
    .then((data) => {
      // don't hold on to empty answers: the data may simply not be synced/published yet
      if (data?.MRData?.total === "0") cache.delete(path);
      return data;
    })
    .catch((err) => { cache.delete(path); throw err; });
  cache.set(path, p);
  return p;
}

/* Prefer our own data: the local database (server.py) or, in production, the
   published static export. Fall back to the live Jolpica API otherwise. */
async function detectDataSource() {
  try {
    // Generous on purpose: a missing file fails fast (404 / file://), but a first visit on a
    // slow connection can take well over a second, and timing out would bypass our own data.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch("api/health.json", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (r.ok) {
      const h = await r.json();
      if (h.ok) {
        const mode = h.source === "static" ? "static" : "local";
        API = LOCAL_API;
        PAGE = mode === "static" ? 1e6 : 5000;   // static files can't page: each holds every row
        DATA = { ...h, mode };
      } else DATA = { mode: "live", note: h.reason };
    }
  } catch (e) { /* no data of our own here: stay on the live API */ }
  const el = document.querySelector("#dataSource");
  if (!el) return;
  el.dataset.mode = DATA.mode;
  const when = DATA.lastSync ? new Date(DATA.lastSync).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—";
  if (DATA.mode === "local") {
    el.textContent = `Local DB · synced ${when}`;
    el.title = `Reading data/f1.db: season ${DATA.season} through round ${DATA.lastRound}. Run python ingest.py to update.`;
  } else if (DATA.mode === "static") {
    el.textContent = `Data updated ${when}`;
    el.title = `Season ${DATA.season} through round ${DATA.lastRound}, from the Jolpica F1 API. Refreshed daily.`;
  } else {
    el.textContent = "Live API · Jolpica";
    el.title = DATA.note || "Reading live from api.jolpi.ca";
  }
}
function sourceName() { return DATA.mode === "local" ? "local SQLite DB" : "Jolpica&nbsp;F1"; }

/* ============================================================
   Reference data: team colours
   ============================================================ */
const TEAM_COLORS = {
  "Red Bull": "#4781d7",
  "Ferrari": "#ed1131",
  "Mercedes": "#00d7b6",
  "McLaren": "#ff8000",
  "RB F1 Team": "#6c98ff",
  "Racing Bulls": "#6c98ff",
  "Audi": "#00a19b",
  "Alpine F1 Team": "#2293d1",
  "Aston Martin": "#2ba489",
  "Haas F1 Team": "#b9bdc4",
  "Williams": "#1ca0e3",
  "Cadillac F1 Team": "#c9a14a",
  "Sauber": "#52c832",
  "Alfa Romeo": "#b12039",
  "AlphaTauri": "#6c98ff",
};
function teamColor(name) { return TEAM_COLORS[name] || "#7c8694"; }

/* ============================================================
   Small helpers
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function ordinal(n) {
  n = Number(n);
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function fullName(d) { return `${d.givenName} ${d.familyName}`; }
function showLoader(msg = "Loading…") {
  view.innerHTML = `<div class="loader"><span class="loader__spin"></span> ${esc(msg)}</div>`;
}
function showError(err) {
  const help = DATA.mode === "local"
    ? `<p>The site is reading your local database. If this round hasn't been synced yet,
         run <code>python ingest.py</code> in the project folder, then refresh.</p>`
    : DATA.mode === "static"
    ? `<p>Try refreshing the page. The race data is republished automatically every day.</p>`
    : `<p>The site is reading the live Jolpica F1 API, so it needs an internet connection.
         To read from your local database instead, run the project server and open its address:</p>
       <p><code>python server.py</code> &nbsp;→&nbsp; <code>http://localhost:8000</code></p>`;
  view.innerHTML = `
    <div class="errbox">
      <h2>Couldn't load the data</h2>
      <p>${esc(err.message || String(err))}</p>
      ${help}
    </div>`;
}
/* Classified finishes: "Finished", "Lapped" (newer seasons) and the older
   "+1 Lap" / "+2 Laps" wording. Anything else (Retired, Accident, Did not
   start, ...) is a non-finish. */
function isFinish(status) {
  return status === "Finished" || status === "Lapped" || /^\+\d+ Laps?$/.test(status || "");
}
function isDNF(status) { return !!status && !isFinish(status); }
function isDNS(status) { return status === "Did not start"; }

/* ============================================================
   Results table (shared by Latest Race and any past race)
   ============================================================ */
function resultsTable(results) {
  const rows = results.map((r) => {
    const d = r.Driver, team = r.Constructor.name;
    const posClass = ["", "p1", "p2", "p3"][Number(r.position)] || "";
    const timeOrStatus = r.Time
      ? `<span class="mono">${esc(r.Time.time)}</span>`
      : (isDNF(r.status)
          ? `<span class="status-dnf">${esc(r.status)}</span>`
          : `<span class="status-fin">${esc(r.status)}</span>`);
    return `
      <tr>
        <td class="pos-cell ${posClass}">${esc(r.positionText)}</td>
        <td>
          <span class="driver-cell">
            <a href="#/driver/${encodeURIComponent(d.driverId)}">${esc(fullName(d))}</a>
            <span class="code">${esc(d.code || "")}</span>
          </span>
        </td>
        <td><span class="team-tag"><i class="bar" style="--team:${teamColor(team)}"></i>${esc(team)}</span></td>
        <td class="num">${esc(r.grid)}</td>
        <td>${timeOrStatus}</td>
        <td class="num"><span class="pts-badge">${esc(r.points)}</span></td>
      </tr>`;
  }).join("");

  return `
    <div class="table-wrap">
      <table class="grid">
        <thead>
          <tr>
            <th>Pos</th><th>Driver</th><th>Team</th>
            <th class="num">Grid</th><th>Time / Status</th><th class="num">Pts</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function raceBanner(race, label = "Round") {
  const loc = race.Circuit.Location;
  return `
    <header class="page-head">
      <p class="eyebrow">${esc(label)} ${esc(race.round)} · ${fmtDate(race.date)}</p>
      <h1>${esc(race.raceName)}</h1>
      <p class="sub">${esc(race.Circuit.circuitName)}, ${esc(loc.locality)}, ${esc(loc.country)}</p>
    </header>`;
}

/* ============================================================
   VIEW: Latest race (home)
   ============================================================ */
async function renderLatest() {
  showLoader("Loading the latest race…");
  try {
    const data = await getJSON("current/last/results.json");
    const race = data.MRData.RaceTable.Races[0];
    if (!race) { view.innerHTML = `<p class="empty-note">No race results available yet this season.</p>`; return; }
    const results = race.Results;
    const podium = results.slice(0, 3);
    const placeLabel = ["Winner", "2nd", "3rd"];

    const podiumHTML = podium.map((r, i) => {
      const team = r.Constructor.name;
      return `
        <article class="podium__card" style="--team:${teamColor(team)}">
          <div class="podium__place">${placeLabel[i]}</div>
          <a class="podium__name" href="#/driver/${encodeURIComponent(r.Driver.driverId)}">${esc(fullName(r.Driver))}</a>
          <div class="podium__team"><i class="bar"></i>${esc(team)}</div>
          <div class="podium__stat">
            <span>${esc(r.Time ? r.Time.time : r.status)}</span>
            <span>${esc(r.points)} pts</span>
          </div>
        </article>`;
    }).join("");

    view.innerHTML = `
      ${raceBanner(race, "Latest race · Round")}
      <div class="podium">${podiumHTML}</div>
      <h2 class="section-title">Classification</h2>
      ${resultsTable(results)}
    `;
  } catch (err) { showError(err); }
}

/* ============================================================
   VIEW: Season schedule (click a completed race for results)
   ============================================================ */
async function renderSeason() {
  showLoader("Loading the season calendar…");
  try {
    const [schedule, lastData] = await Promise.all([
      getJSON("current.json"),
      getJSON("current/last/results.json"),
    ]);
    const races = schedule.MRData.RaceTable.Races;
    const season = schedule.MRData.RaceTable.season;
    const lastRound = Number(lastData.MRData.RaceTable.Races[0]?.round || 0);

    const cells = races.map((r) => {
      const done = Number(r.round) <= lastRound;
      const isNext = Number(r.round) === lastRound + 1;
      const loc = r.Circuit.Location;
      const pill = done
        ? `<span class="pill result">Results</span>`
        : isNext ? `<span class="pill next">Next</span>` : "";
      const tag = done ? "button" : "div";
      const attrs = done
        ? `class="race-cell done" data-round="${esc(r.round)}"`
        : `class="race-cell upcoming${isNext ? " is-next" : ""}"`;
      return `
        <${tag} ${attrs}>
          <div class="race-cell__top">
            <span class="race-cell__round">Round ${esc(r.round)}</span>
            ${pill}
          </div>
          <div class="race-cell__name">${esc(r.raceName.replace(/ Grand Prix$/, " GP"))}</div>
          <div class="race-cell__circuit">${esc(loc.locality)}, ${esc(loc.country)}</div>
          <div class="race-cell__date">${fmtDate(r.date)}</div>
        </${tag}>`;
    }).join("");

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(season)} season</h1>
        <p class="sub">${races.length} rounds, ${lastRound} completed. Open a finished round for its results.</p>
      </div>
      <div class="race-grid">${cells}</div>
    `;

    view.querySelectorAll(".race-cell.done").forEach((el) => {
      el.addEventListener("click", () => { location.hash = `#/race/${el.dataset.round}`; });
    });
  } catch (err) { showError(err); }
}

/* ============================================================
   VIEW: A specific past race's results
   ============================================================ */
async function renderRace(round) {
  showLoader(`Loading round ${round}…`);
  try {
    const data = await getJSON(`current/${encodeURIComponent(round)}/results.json`);
    const race = data.MRData.RaceTable.Races[0];
    if (!race) { view.innerHTML = `<a class="back-link" href="#/season">‹ Season</a><p class="empty-note">No results for this round yet.</p>`; return; }
    view.innerHTML = `
      <a class="back-link" href="#/season">‹ Season</a>
      ${raceBanner(race)}
      <h2 class="section-title">Classification</h2>
      ${resultsTable(race.Results)}
    `;
  } catch (err) { showError(err); }
}

/* ============================================================
   VIEW: Championship standings
   ============================================================ */
async function renderStandings() {
  showLoader("Loading the championship…");
  try {
    const data = await getJSON("current/driverstandings.json");
    const list = data.MRData.StandingsTable.StandingsLists[0];
    if (!list) { view.innerHTML = `<p class="empty-note">Standings aren't available yet.</p>`; return; }
    const season = data.MRData.StandingsTable.season;
    const rows = list.DriverStandings.map((s) => {
      const d = s.Driver, team = s.Constructors[s.Constructors.length - 1]?.name || "—";
      const posClass = ["", "p1", "p2", "p3"][Number(s.position)] || "";
      return `
        <tr>
          <td class="pos-cell ${posClass}">${esc(s.position)}</td>
          <td>
            <span class="driver-cell">
              <a href="#/driver/${encodeURIComponent(d.driverId)}">${esc(fullName(d))}</a>
              <span class="code">${esc(d.code || "")}</span>
            </span>
          </td>
          <td><span class="team-tag"><i class="bar" style="--team:${teamColor(team)}"></i>${esc(team)}</span></td>
          <td class="num">${esc(s.wins)}</td>
          <td class="num"><span class="pts-badge">${esc(s.points)}</span></td>
        </tr>`;
    }).join("");

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(season)} drivers' standings</h1>
        <p class="sub">After round ${esc(list.round)}.</p>
      </div>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Wins</th><th class="num">Pts</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) { showError(err); }
}

/* ============================================================
   VIEW: Individual driver data (season results + charts)
   ============================================================ */
async function renderDriver(driverId) {
  showLoader("Loading driver data…");
  try {
    const [resData, standData, schedule] = await Promise.all([
      getJSON(`current/drivers/${encodeURIComponent(driverId)}/results.json`),
      getJSON("current/driverstandings.json"),
      getJSON("current.json"),
    ]);
    const table = resData.MRData.RaceTable;
    const races = table.Races;
    if (!races.length) { view.innerHTML = `<a class="back-link" href="#/standings">‹ Standings</a><p class="empty-note">No race data for this driver yet.</p>`; return; }

    const driver = races[0].Results[0].Driver;
    const standings = standData.MRData.StandingsTable.StandingsLists[0]?.DriverStandings || [];
    const standing = standings.find((s) => s.Driver.driverId === driverId);
    const team = races[races.length - 1].Results[0].Constructor.name;
    const tc = teamColor(team);

    // Per-race series
    const series = races.map((r) => {
      const res = r.Results[0];
      return {
        round: Number(r.round),
        name: r.raceName.replace(/ Grand Prix$/, " GP"),
        grid: Number(res.grid) || null,
        finish: Number(res.position),
        finishText: res.positionText,
        status: res.status,
        points: Number(res.points),
        dnf: isDNF(res.status),
      };
    });

    // Stats
    const wins = series.filter((s) => s.finish === 1).length;
    const podiums = series.filter((s) => s.finish <= 3 && !s.dnf).length;
    const pointsFinishes = series.filter((s) => s.points > 0).length;
    const dnfs = series.filter((s) => s.dnf && !isDNS(s.status)).length;
    const bestFinish = Math.min(...series.filter((s) => !s.dnf).map((s) => s.finish).concat([99]));
    const totalPoints = standing ? Number(standing.points) : series.reduce((a, s) => a + s.points, 0);
    const champPos = standing ? standing.position : "—";

    // Season-end projection: current points + average points/race over remaining rounds
    const totalRounds = schedule.MRData.RaceTable.Races.length;
    const completed = series.length ? series[series.length - 1].round : 0;
    const remaining = Math.max(0, totalRounds - completed);
    const avgPPR = series.length ? series.reduce((a, s) => a + s.points, 0) / series.length : 0;
    const projectedFinal = Math.round(totalPoints + avgPPR * remaining);

    const age = (() => {
      const b = new Date(driver.dateOfBirth);
      let a = TODAY.getFullYear() - b.getFullYear();
      if (TODAY < new Date(TODAY.getFullYear(), b.getMonth(), b.getDate())) a--;
      return a;
    })();

    view.innerHTML = `
      <a class="back-link" href="#/standings">‹ Standings</a>
      <header class="page-head driver-hero" style="--team:${tc}">
        <h1>${esc(fullName(driver))} <span class="driver-hero__num">${esc(driver.permanentNumber || "")}</span></h1>
        <p class="sub driver-hero__meta">
          <span class="team-tag"><i class="bar"></i>${esc(team)}</span>
          <span>${esc(driver.nationality)}</span>
          <span>${age} years old</span>
          <span>${esc(ordinalSafe(champPos))} in the championship</span>
        </p>
      </header>

      <div class="stat-row">
        <div class="stat-tile"><div class="k">Points</div><div class="v">${esc(totalPoints)}</div></div>
        <div class="stat-tile"><div class="k">Wins</div><div class="v">${wins}</div></div>
        <div class="stat-tile"><div class="k">Podiums</div><div class="v">${podiums}</div></div>
        <div class="stat-tile"><div class="k">Best finish</div><div class="v">${bestFinish === 99 ? "—" : "P" + bestFinish}</div></div>
        <div class="stat-tile"><div class="k">Pts finishes</div><div class="v">${pointsFinishes}<small> / ${series.length}</small></div></div>
        <div class="stat-tile"><div class="k">DNFs</div><div class="v">${dnfs}</div></div>
        ${remaining > 0 ? `<div class="stat-tile"><div class="k">Projected final</div><div class="v">${projectedFinal}<small> pts</small></div></div>` : ""}
      </div>

      <div class="chart-grid" style="margin-top:18px">
        <div class="chart-card">
          <h3>Finishing position by round</h3>
          <p class="csub">Grid (grey) vs finish (team colour). Lower is better.</p>
          <div class="chart" id="posChart"></div>
          <div class="chart-legend">
            <span><i style="border-color:${tc}"></i>Finish</span>
            <span><i style="border-color:var(--faint);border-top-style:dashed"></i>Grid</span>
          </div>
        </div>
        <div class="chart-card">
          <h3>Points progression</h3>
          <p class="csub">Cumulative points${remaining > 0 ? `, with a projection to round ${totalRounds}` : ""}.</p>
          <div class="chart" id="ptsChart"></div>
          ${remaining > 0 ? `<div class="chart-legend">
            <span><i style="border-color:${tc}"></i>Actual</span>
            <span><i class="forecast" style="border-color:${tc}"></i>Projected (${projectedFinal} pts)</span>
          </div>` : ""}
        </div>
      </div>

      <h2 class="section-title">Race by race</h2>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Rd</th><th>Grand Prix</th><th class="num">Grid</th><th class="num">Finish</th><th>Status</th><th class="num">Pts</th></tr></thead>
          <tbody>${series.map((s) => `
            <tr>
              <td class="mono">${s.round}</td>
              <td><a href="#/race/${s.round}">${esc(s.name)}</a></td>
              <td class="num">${s.grid ?? "—"}</td>
              <td class="num ${s.finish === 1 ? "pos-cell p1" : s.finish === 2 ? "pos-cell p2" : s.finish === 3 ? "pos-cell p3" : ""}">${esc(s.finishText)}</td>
              <td>${s.dnf ? `<span class="status-dnf">${esc(s.status)}</span>` : `<span class="status-fin">${esc(s.status)}</span>`}</td>
              <td class="num"><span class="pts-badge">${s.points}</span></td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    `;

    drawPositionChart($("#posChart"), series, tc);
    drawPointsChart($("#ptsChart"), series, tc, remaining > 0 ? { round: totalRounds, total: projectedFinal } : null);
    setActiveDriver(driverId);
  } catch (err) { showError(err); }
}
function ordinalSafe(v) { return v === "—" ? "—" : ordinal(v); }

/* ============================================================
   Charts (hand-drawn SVG, theme-aware, with hover tooltips)
   ============================================================ */
let tipEl;
function tip() {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "chart-tip"; document.body.appendChild(tipEl); }
  return tipEl;
}
function showTip(html, evt) {
  const t = tip();
  t.innerHTML = html;
  t.style.opacity = "1";
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = evt.clientY - r.height - pad;
  t.style.left = x + "px"; t.style.top = y + "px";
}
function hideTip() { if (tipEl) tipEl.style.opacity = "0"; }

const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  for (const k in attrs) {
    const val = attrs[k];
    // CSS custom properties aren't valid in SVG presentation attributes, and the
    // `.chart text` rule would override a plain colour attribute — route colours
    // through inline style, which supports var() and wins over the stylesheet.
    if ((k === "fill" || k === "stroke") && (String(val).includes("var(") || name === "text")) el.style[k] = val;
    else el.setAttribute(k, val);
  }
  return el;
}
/* client x -> position on the chart's viewBox x-axis */
function pointerLap(evt, svg, W, mL, iw, lastLap) {
  const r = svg.getBoundingClientRect();
  const vbx = ((evt.clientX - r.left) / r.width) * W;
  return Math.max(1, Math.min(lastLap, Math.round(1 + ((vbx - mL) / iw) * (lastLap - 1))));
}

function drawPositionChart(host, series, tc) {
  const W = 460, H = 240, m = { t: 14, r: 14, b: 26, l: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const rounds = series.map((s) => s.round);
  const maxPos = Math.max(20, ...series.map((s) => s.finish), ...series.map((s) => s.grid || 0));
  const x = (r) => m.l + (rounds.length === 1 ? iw / 2 : ((r - rounds[0]) / (rounds[rounds.length - 1] - rounds[0])) * iw);
  const y = (p) => m.t + ((p - 1) / (maxPos - 1)) * ih; // P1 at top

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Finishing position by round" });

  // gridlines + y labels at P1, P5, P10, P15, P20
  [1, 5, 10, 15, 20].filter((p) => p <= maxPos).forEach((p) => {
    const yy = y(p);
    svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: yy, x2: W - m.r, y2: yy }));
    const t = svgEl("text", { x: m.l - 6, y: yy + 3, "text-anchor": "end" }); t.textContent = "P" + p; svg.appendChild(t);
  });
  // x labels (every other round to avoid crowding)
  series.forEach((s, i) => {
    if (i % 2 === 0 || rounds.length <= 10) {
      const t = svgEl("text", { x: x(s.round), y: H - 8, "text-anchor": "middle" }); t.textContent = s.round; svg.appendChild(t);
    }
  });

  // grid line (dashed, muted)
  const gridPts = series.filter((s) => s.grid).map((s) => `${x(s.round)},${y(s.grid)}`).join(" ");
  if (gridPts) svg.appendChild(svgEl("polyline", { points: gridPts, fill: "none", stroke: "var(--faint)", "stroke-width": 1.5, "stroke-dasharray": "4 4", "stroke-linejoin": "round", opacity: .8 }));

  // finish line (team colour)
  const finPts = series.map((s) => `${x(s.round)},${y(s.finish)}`).join(" ");
  svg.appendChild(svgEl("polyline", { points: finPts, fill: "none", stroke: tc, "stroke-width": 2.4, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // markers + hover targets
  series.forEach((s) => {
    const cx = x(s.round), cy = y(s.finish);
    svg.appendChild(svgEl("circle", { cx, cy, r: s.finish === 1 ? 4.5 : 3.6, fill: s.dnf ? "var(--bad)" : tc, stroke: "var(--surface)", "stroke-width": 1.6 }));
    const hit = svgEl("circle", { cx, cy, r: 11, fill: "transparent" });
    hit.style.cursor = "pointer";
    const html = `<b>${esc(s.name)}</b><br>Grid <span class="tv">P${s.grid ?? "—"}</span> → Finish <span class="tv">${esc(s.finishText)}</span>${s.dnf ? ` (${esc(s.status)})` : ""}`;
    hit.addEventListener("mousemove", (e) => showTip(html, e));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });

  host.appendChild(svg);
}

function drawPointsChart(host, series, tc, forecast) {
  const W = 460, H = 240, m = { t: 14, r: forecast ? 30 : 16, b: 26, l: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  let cum = 0;
  const pts = series.map((s) => { cum += s.points; return { round: s.round, name: s.name, total: cum, gained: s.points }; });
  const rounds = pts.map((p) => p.round);
  const xMaxRound = forecast ? forecast.round : rounds[rounds.length - 1];
  const maxPts = Math.max(10, cum, forecast ? forecast.total : 0);
  const x = (r) => m.l + (xMaxRound === rounds[0] ? iw / 2 : ((r - rounds[0]) / (xMaxRound - rounds[0])) * iw);
  const y = (v) => m.t + ih - (v / maxPts) * ih;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Cumulative points progression" });

  // y gridlines (4 steps)
  const step = niceStep(maxPts / 4);
  for (let v = 0; v <= maxPts + 0.1; v += step) {
    const yy = y(v);
    svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: yy, x2: W - m.r, y2: yy }));
    const t = svgEl("text", { x: m.l - 6, y: yy + 3, "text-anchor": "end" }); t.textContent = Math.round(v); svg.appendChild(t);
  }
  pts.forEach((p, i) => {
    if (i % 2 === 0 || rounds.length <= 10) {
      const t = svgEl("text", { x: x(p.round), y: H - 8, "text-anchor": "middle" }); t.textContent = p.round; svg.appendChild(t);
    }
  });

  // area fill
  const line = pts.map((p) => `${x(p.round)},${y(p.total)}`).join(" ");
  const area = `${m.l},${y(0)} ${line} ${x(pts[pts.length - 1].round)},${y(0)}`;
  svg.appendChild(svgEl("polygon", { points: area, fill: tc, opacity: .13 }));
  svg.appendChild(svgEl("polyline", { points: line, fill: "none", stroke: tc, "stroke-width": 2.4, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // endpoint emphasis
  const last = pts[pts.length - 1];

  // projected continuation (dashed) to the final round
  if (forecast && forecast.round > last.round) {
    svg.appendChild(svgEl("polyline", {
      points: `${x(last.round)},${y(last.total)} ${x(forecast.round)},${y(forecast.total)}`,
      fill: "none", stroke: tc, "stroke-width": 2, "stroke-dasharray": "5 4", "stroke-opacity": .75, "stroke-linecap": "round",
    }));
    const hollow = svgEl("circle", { cx: x(forecast.round), cy: y(forecast.total), r: 4, fill: "var(--surface)", "stroke-width": 2 });
    hollow.style.stroke = tc; svg.appendChild(hollow);
    const fl = svgEl("text", { x: x(forecast.round), y: y(forecast.total) - 9, "text-anchor": "end" });
    fl.style.fill = tc; fl.textContent = forecast.total; svg.appendChild(fl);
    const ft = svgEl("text", { x: x(forecast.round), y: H - 8, "text-anchor": "middle" }); ft.textContent = forecast.round; svg.appendChild(ft);
  }

  svg.appendChild(svgEl("circle", { cx: x(last.round), cy: y(last.total), r: 4.5, fill: tc, stroke: "var(--surface)", "stroke-width": 2 }));

  pts.forEach((p) => {
    const cx = x(p.round), cy = y(p.total);
    const hit = svgEl("circle", { cx, cy, r: 11, fill: "transparent" }); hit.style.cursor = "pointer";
    const html = `<b>${esc(p.name)}</b><br>Total <span class="tv">${p.total} pts</span> &middot; +<span class="tv">${p.gained}</span> this race`;
    hit.addEventListener("mousemove", (e) => showTip(html, e));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });

  host.appendChild(svg);
}
function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return Math.max(1, m * pow);
}

/* ============================================================
   RACE ANALYTICS DASHBOARD
   A small client-side data pipeline: pull results + ~1.2k lap
   timing rows + pit stops + qualifying, join them by driver,
   and derive pace, consistency, strategy and race-flow metrics.
   ============================================================ */
const lapCache = new Map(); // round -> { lapMap, totalRows, laps }

function toSec(t) {
  if (!t) return null;
  const p = String(t).split(":");
  const v = p.length === 2 ? Number(p[0]) * 60 + parseFloat(p[1]) : parseFloat(t);
  return isNaN(v) ? null : v;
}
function fmtLap(s) {
  if (s == null || isNaN(s)) return "—";
  const m = Math.floor(s / 60), r = s - m * 60;
  return m > 0 ? `${m}:${r.toFixed(3).padStart(6, "0")}` : r.toFixed(3);
}
function driverCode(d) { return d.code || d.familyName.slice(0, 3).toUpperCase(); }

/* Page through every lap-timing row and fold them into a lap -> driver matrix */
async function getRaceLaps(round) {
  if (lapCache.has(round)) return lapCache.get(round);
  const prog = $("#dashProgress");
  const lapMap = new Map();
  const ingest = (resp) => {
    const R = resp.MRData.RaceTable.Races;
    if (!R.length) return;
    for (const lap of R[0].Laps) {
      const n = Number(lap.number);
      let mm = lapMap.get(n);
      if (!mm) { mm = new Map(); lapMap.set(n, mm); }
      for (const tm of lap.Timings) mm.set(tm.driverId, { pos: Number(tm.position), t: toSec(tm.time) });
    }
  };
  const first = await getJSON(`current/${round}/laps.json?limit=${PAGE}&offset=0`);
  const total = Number(first.MRData.total) || 0;
  ingest(first);
  for (let off = PAGE; off < total; off += PAGE) {
    if (prog) prog.textContent = `Processing lap telemetry… ${Math.min(off, total)} / ${total} rows`;
    ingest(await getJSON(`current/${round}/laps.json?limit=${PAGE}&offset=${off}`));
  }
  const out = { lapMap, totalRows: total, laps: [...lapMap.keys()].sort((a, b) => a - b) };
  if (out.laps.length) lapCache.set(round, out);   // an empty round is re-checked next visit
  return out;
}

function buildDriverLaps(lapMap, laps) {
  const byDriver = new Map();
  for (const n of laps) {
    for (const [did, v] of lapMap.get(n)) {
      if (!byDriver.has(did)) byDriver.set(did, []);
      byDriver.get(did).push({ lap: n, pos: v.pos, t: v.t });
    }
  }
  return byDriver;
}
function paceStats(series) {
  const times = series.map((p) => p.t).filter((t) => t && t > 0);
  if (!times.length) return { best: null, median: null, sd: null, count: 0 };
  const best = Math.min(...times);
  const green = times.filter((t) => t <= best * 1.07);     // drop pit / SC / out-laps
  const sorted = [...green].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = green.reduce((a, b) => a + b, 0) / green.length;
  const sd = Math.sqrt(green.reduce((a, b) => a + (b - mean) ** 2, 0) / green.length);
  return { best, median, sd, count: green.length };
}
function raceDynamics(lapMap, laps) {
  let leadChanges = 0, prevLeader = null;
  const lapsLed = new Map();
  let fastest = { t: Infinity, did: null, lap: null };
  for (const n of laps) {
    const m = lapMap.get(n);
    let leader = null;
    for (const [did, v] of m) {
      if (v.pos === 1) leader = did;
      if (v.t && v.t < fastest.t) fastest = { t: v.t, did, lap: n };
    }
    if (leader) {
      lapsLed.set(leader, (lapsLed.get(leader) || 0) + 1);
      if (prevLeader && leader !== prevLeader) leadChanges++;
      prevLeader = leader;
    }
  }
  return { leadChanges, lapsLed, fastest: fastest.did ? fastest : null };
}

async function renderDashboard(round) {
  view.innerHTML = `<div class="loader"><span class="loader__spin"></span> Building race analytics…</div><div class="dash-progress" id="dashProgress"></div>`;
  try {
    const lastData = await getJSON("current/last/results.json");
    const lastRound = Number(lastData.MRData.RaceTable.Races[0]?.round) || 0;
    if (!round) round = lastRound;

    const [resData, pitData, qualData, schedule] = await Promise.all([
      getJSON(`current/${round}/results.json`),
      getJSON(`current/${round}/pitstops.json?limit=${PAGE}`).catch(() => null),
      getJSON(`current/${round}/qualifying.json?limit=${PAGE}`).catch(() => null),
      getJSON("current.json"),
    ]);

    const race = resData.MRData.RaceTable.Races[0];
    if (!race) { view.innerHTML = `<p class="empty-note">No results for round ${esc(round)} yet.</p>`; return; }
    const results = race.Results;
    const N = results.length;

    // --- index drivers ---
    const info = new Map(); // driverId -> {name, code, team, color, grid, finish, points, status, dnf}
    results.forEach((r) => {
      const team = r.Constructor.name;
      info.set(r.Driver.driverId, {
        name: fullName(r.Driver), code: driverCode(r.Driver), team, color: teamColor(team),
        grid: Number(r.grid) || N, finish: Number(r.position), status: r.status,
        points: Number(r.points), dnf: isDNF(r.status),
      });
    });

    // --- pit stops ---
    const pitStops = pitData?.MRData.RaceTable.Races[0]?.PitStops || [];
    const pitsByDriver = new Map();
    let fastestStop = { dur: Infinity, did: null };
    pitStops.forEach((p) => {
      if (!pitsByDriver.has(p.driverId)) pitsByDriver.set(p.driverId, []);
      pitsByDriver.get(p.driverId).push({ lap: Number(p.lap), dur: parseFloat(p.duration) });
      const dur = parseFloat(p.duration);
      if (dur && dur < fastestStop.dur) fastestStop = { dur, did: p.driverId };
    });

    // --- qualifying (pole) ---
    const quali = qualData?.MRData.RaceTable.Races[0]?.QualifyingResults || [];
    const pole = quali.find((q) => q.position === "1");
    const poleName = pole ? fullName(pole.Driver) : (results.find((r) => r.grid === "1")?.Driver && fullName(results.find((r) => r.grid === "1").Driver)) || "—";

    // --- lap telemetry ---
    const { lapMap, totalRows, laps } = await getRaceLaps(round);
    const hasLaps = laps.length > 0;
    const byDriver = hasLaps ? buildDriverLaps(lapMap, laps) : new Map();
    const dyn = hasLaps ? raceDynamics(lapMap, laps) : { leadChanges: 0, lapsLed: new Map(), fastest: null };
    const lastLap = hasLaps ? laps[laps.length - 1] : 0;

    // --- derived per-driver pace ---
    const pace = new Map();
    byDriver.forEach((series, did) => pace.set(did, paceStats(series)));

    // --- KPIs ---
    const winner = info.get(results[0].Driver.driverId);
    const movers = [...info.entries()]
      .filter(([, v]) => !v.dnf)
      .map(([, v]) => ({ ...v, delta: v.grid - v.finish }))
      .sort((a, b) => b.delta - a.delta);
    const topMover = movers[0];
    const dnsCount = [...info.values()].filter((v) => isDNS(v.status)).length;
    const dnfCount = [...info.values()].filter((v) => v.dnf && !isDNS(v.status)).length;
    const flDriver = dyn.fastest ? info.get(dyn.fastest.did) : null;

    const kpis = [
      { k: "Winner", v: winner.name, meta: winner.team },
      { k: "Pole position", v: poleName, meta: "Qualifying P1" },
      { k: "Fastest lap", v: flDriver ? flDriver.code : "—", meta: dyn.fastest ? `${fmtLap(dyn.fastest.t)} · lap ${dyn.fastest.lap}` : "no lap data" },
      { k: "Biggest climber", v: topMover ? `${topMover.code} +${topMover.delta}` : "—", meta: topMover ? `P${topMover.grid} → P${topMover.finish}` : "" },
      { k: "Lead changes", v: hasLaps ? String(dyn.leadChanges) : "—", meta: `${lastLap} laps` },
      { k: "DNFs", v: String(dnfCount), meta: `${N - dnsCount} starters` },
    ];

    // --- race selector options (completed rounds only) ---
    const options = schedule.MRData.RaceTable.Races
      .filter((r) => Number(r.round) <= lastRound)
      .map((r) => `<option value="${esc(r.round)}" ${Number(r.round) === Number(round) ? "selected" : ""}>R${esc(r.round)} · ${esc(r.raceName.replace(/ Grand Prix$/, " GP"))}</option>`)
      .reverse().join("");

    const loc = race.Circuit.Location;
    view.innerHTML = `
      <div class="dash-head">
        <div class="page-head" style="margin:0">
          <p class="eyebrow">Race analytics · Round ${esc(race.round)} · ${fmtDate(race.date)}</p>
          <h1>${esc(race.raceName)}</h1>
          <p class="sub">${esc(race.Circuit.circuitName)}, ${esc(loc.locality)}, ${esc(loc.country)}</p>
        </div>
        <div class="round-select-wrap">
          <select class="round-select" id="roundSelect" aria-label="Choose a race">${options}</select>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </div>

      <div class="kpi-row">
        ${kpis.map((x) => `<div class="kpi"><div class="k">${esc(x.k)}</div><div class="v">${esc(x.v)}</div><div class="meta2">${esc(x.meta)}</div></div>`).join("")}
      </div>

      <div class="dash-grid">
        <div class="chart-card">
          <h3>Positions gained &amp; lost</h3>
          <p class="csub">Grid position minus finishing position (classified finishers).</p>
          <div id="moversChart"></div>
        </div>
        <div class="chart-card">
          <h3>Points by team</h3>
          <p class="csub">Combined points scored this race.</p>
          <div id="teamPtsChart"></div>
        </div>

        <div class="chart-card span-2">
          <h3>Race progression</h3>
          <p class="csub">Track position on every lap, coloured by team. Hover a line to trace a driver.</p>
          <div class="chart" id="progChart"></div>
          <div class="progression-note" id="progNote"></div>
        </div>

        <div class="chart-card span-2">
          <h3>Lap-time pace — top 5 finishers</h3>
          <p class="csub">Lap times across the race; pit and safety-car laps are bridged. Lower is faster.</p>
          <div class="chart" id="paceChart"></div>
          <div class="pace-legend" id="paceLegend"></div>
        </div>

        <div class="chart-card span-2">
          <h3>Pit-stop strategy</h3>
          <p class="csub">Stint lengths between pit stops, ordered by finishing position.</p>
          <div id="stintChart"></div>
          <div class="stint-legend">Each bar is a driver's race; segments are stints split by pit stops. Numbers are laps in the stint.</div>
        </div>

        <div class="span-2">
          <h2 class="section-title" style="margin-top:6px">Driver analysis</h2>
          <div class="table-wrap">
            <table class="grid" id="analysisTable">
              <thead><tr>
                <th>Pos</th><th>Driver</th><th>Team</th>
                <th class="num">Grid</th><th class="num">+/−</th>
                <th class="num">Best lap</th><th class="num">Median pace</th><th class="num">Consistency</th>
                <th class="num">Stops</th><th class="num">Pts</th>
              </tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>

      <p class="pipeline">
        Built in your browser from ${N} results, ${totalRows.toLocaleString()} lap rows, ${pitStops.length} pit stops
        and ${quali.length} qualifying times. Source: ${sourceName()}.
      </p>
    `;

    // round selector
    $("#roundSelect").addEventListener("change", (e) => { location.hash = `#/dashboard/${e.target.value}`; });

    // ---- charts ----
    drawMovers($("#moversChart"), movers);
    drawTeamPoints($("#teamPtsChart"), results);
    if (hasLaps) {
      drawProgression($("#progChart"), byDriver, info, N, lastLap);
      const top5 = results.slice(0, 5).map((r) => r.Driver.driverId).filter((d) => byDriver.has(d));
      drawPace($("#paceChart"), $("#paceLegend"), top5, byDriver, info);
      drawStints($("#stintChart"), results, pitsByDriver, byDriver, lastLap);
      $("#progNote").textContent = dyn.fastest ? `Fastest lap: ${info.get(dyn.fastest.did).name} — ${fmtLap(dyn.fastest.t)} on lap ${dyn.fastest.lap}.` : "";
    } else {
      const msg = DATA.mode === "local"
        ? `<p class="empty-note">Lap data for this round isn't in your local database yet. Run <code>python ingest.py</code>, then reopen this page.</p>`
        : `<p class="empty-note">Lap-by-lap data isn't published for this round yet.</p>`;
      $("#progChart").innerHTML = msg; $("#paceChart").innerHTML = msg; $("#stintChart").innerHTML = msg;
    }
    fillAnalysisTable($("#analysisTable tbody"), results, info, pace, pitsByDriver, fastestStop);

  } catch (err) { showError(err); }
}

/* ---- Positions gained/lost: diverging horizontal bars ---- */
function drawMovers(host, movers) {
  if (!movers.length) { host.innerHTML = `<p class="empty-note">No classified finishers.</p>`; return; }
  const max = Math.max(1, ...movers.map((m) => Math.abs(m.delta)));
  host.innerHTML = `<div class="bar-list">` + movers.map((m) => {
    const w = (Math.abs(m.delta) / max) * 50; // half-track percentage
    const cls = m.delta > 0 ? "up" : m.delta < 0 ? "down" : "zero";
    const fill = m.delta === 0 ? "" : `<span class="mover-fill ${cls}" style="width:${w}%"></span>`;
    const val = m.delta > 0 ? `+${m.delta}` : m.delta;
    return `
      <div class="mover-row">
        <span class="bar-row__label" title="${esc(m.name)}">${esc(m.code)} · ${esc(m.name.split(" ").slice(-1)[0])}</span>
        <span class="mover-track">${fill}</span>
        <span class="mover-val ${cls}">${esc(val)}</span>
      </div>`;
  }).join("") + `</div>`;
}

/* ---- Points by team: ranked bars ---- */
function drawTeamPoints(host, results) {
  const byTeam = new Map();
  results.forEach((r) => {
    const t = r.Constructor.name;
    byTeam.set(t, (byTeam.get(t) || 0) + Number(r.points));
  });
  const rows = [...byTeam.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  host.innerHTML = `<div class="bar-list">` + rows.map(([team, pts]) => `
      <div class="bar-row">
        <span class="bar-row__label" title="${esc(team)}">${esc(team.replace(/ F1 Team$/, ""))}</span>
        <span class="bar-row__track"><span class="bar-row__fill" style="width:${(pts / max) * 100}%;--bc:${teamColor(team)}"></span></span>
        <span class="bar-row__val">${pts}</span>
      </div>`).join("") + `</div>`;
}

/* ---- Race progression: position per lap, coloured by team ---- */
function drawProgression(host, byDriver, info, N, lastLap) {
  const W = 900, H = 430, m = { t: 14, r: 52, b: 28, l: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = (lap) => m.l + (lastLap <= 1 ? 0 : ((lap - 1) / (lastLap - 1)) * iw);
  const y = (pos) => m.t + ((pos - 1) / (N - 1)) * ih;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Track position by lap" });

  [1, 5, 10, 15, 20].filter((p) => p <= N).forEach((p) => {
    const yy = y(p);
    svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: yy, x2: W - m.r, y2: yy }));
    const t = svgEl("text", { x: m.l - 6, y: yy + 3, "text-anchor": "end" }); t.textContent = "P" + p; svg.appendChild(t);
  });
  const xticks = lastLap > 40 ? 10 : 5;
  for (let lap = 1; lap <= lastLap; lap += Math.max(1, Math.round(lastLap / xticks))) {
    const t = svgEl("text", { x: x(lap), y: H - 8, "text-anchor": "middle" }); t.textContent = lap; svg.appendChild(t);
  }

  const lines = [];
  byDriver.forEach((series, did) => {
    const meta = info.get(did); if (!meta) return;
    const pts = series.map((p) => `${x(p.lap)},${y(p.pos)}`).join(" ");
    const line = svgEl("polyline", { points: pts, fill: "none", stroke: meta.color, "stroke-width": 1.7, "stroke-linejoin": "round", "stroke-opacity": .9, "data-did": did });
    svg.appendChild(line);
    // end label at final position
    const last = series[series.length - 1];
    const lbl = svgEl("text", { x: W - m.r + 5, y: y(last.pos) + 3, class: "prog-label", "data-lbl": did });
    lbl.style.fill = meta.color; lbl.textContent = meta.code;
    svg.appendChild(lbl);
    // fat transparent hit target
    const hit = svgEl("polyline", { points: pts, fill: "none", stroke: "transparent", "stroke-width": 9 });
    hit.style.cursor = "pointer";
    hit.addEventListener("mouseenter", () => highlightLine(lines, did));
    hit.addEventListener("mousemove", (e) => {
      const lap = pointerLap(e, svg, W, m.l, iw, lastLap);
      const pt = series.find((p) => p.lap === lap) || last;
      showTip(`<b>${esc(meta.name)}</b><br><span class="tv">Lap ${pt.lap} · P${pt.pos}</span>`, e);
    });
    hit.addEventListener("mouseleave", () => { highlightLine(lines, null); hideTip(); });
    svg.appendChild(hit);
    lines.push({ did, line, lbl });
  });
  host.innerHTML = ""; host.appendChild(svg);
}
function highlightLine(lines, did) {
  lines.forEach((l) => {
    const on = did == null || l.did === did;
    l.line.setAttribute("stroke-opacity", did == null ? .9 : (on ? 1 : .12));
    l.line.setAttribute("stroke-width", on && did != null ? 3 : 1.7);
    l.lbl.setAttribute("opacity", did == null ? 1 : (on ? 1 : .2));
  });
}

/* ---- Lap-time pace: top-5 lines with a snapping crosshair ---- */
function drawPace(host, legendHost, drivers, byDriver, info) {
  const seriesColors = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
  const W = 900, H = 340, m = { t: 14, r: 44, b: 28, l: 46 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const all = drivers.flatMap((d) => byDriver.get(d).map((p) => p.t).filter((t) => t));
  if (!all.length) { host.innerHTML = `<p class="empty-note">No lap times.</p>`; return; }
  const best = Math.min(...all);
  const yMax = best * 1.09, yMin = best * 0.996;
  const lastLap = Math.max(...drivers.flatMap((d) => byDriver.get(d).map((p) => p.lap)));
  const x = (lap) => m.l + (lastLap <= 1 ? 0 : ((lap - 1) / (lastLap - 1)) * iw);
  const y = (t) => m.t + ((t - yMin) / (yMax - yMin)) * ih;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Lap times for the top five finishers" });
  // y gridlines in seconds
  const span = yMax - yMin, step = span > 6 ? 2 : 1;
  for (let t = Math.ceil(yMin); t <= yMax; t += step) {
    const yy = y(t);
    svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: yy, x2: W - m.r, y2: yy }));
    const lab = svgEl("text", { x: m.l - 6, y: yy + 3, "text-anchor": "end" }); lab.textContent = fmtLap(t); svg.appendChild(lab);
  }
  for (let lap = 1; lap <= lastLap; lap += Math.max(1, Math.round(lastLap / 10))) {
    const t = svgEl("text", { x: x(lap), y: H - 8, "text-anchor": "middle" }); t.textContent = lap; svg.appendChild(t);
  }

  // one continuous line per driver, bridging clipped (pit / safety-car) laps
  const labels = [];
  drivers.forEach((did, i) => {
    const col = seriesColors[i];
    const inRange = byDriver.get(did).filter((p) => p.t && p.t <= yMax);
    if (inRange.length < 2) return;
    const pts = inRange.map((p) => `${x(p.lap)},${y(p.t)}`).join(" ");
    svg.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const lastGood = inRange[inRange.length - 1];
    labels.push({ yy: y(lastGood.t), xx: Math.min(x(lastGood.lap) + 6, W - 6), col, code: info.get(did).code });
  });
  // nudge labels apart so they don't overlap at the line ends
  labels.sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < labels.length; i++) if (labels[i].yy - labels[i - 1].yy < 11) labels[i].yy = labels[i - 1].yy + 11;
  labels.forEach((lp) => { const lab = svgEl("text", { x: lp.xx, y: lp.yy + 3, class: "prog-label", fill: lp.col }); lab.textContent = lp.code; svg.appendChild(lab); });

  // crosshair overlay
  const cross = svgEl("line", { y1: m.t, y2: H - m.b, stroke: "var(--border-2)", "stroke-width": 1, opacity: 0 });
  svg.appendChild(cross);
  const overlay = svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
  overlay.style.cursor = "crosshair";
  overlay.addEventListener("mousemove", (e) => {
    const lap = pointerLap(e, svg, W, m.l, iw, lastLap);
    cross.setAttribute("x1", x(lap)); cross.setAttribute("x2", x(lap)); cross.setAttribute("opacity", 1);
    const rows = drivers.map((did, i) => {
      const p = byDriver.get(did).find((q) => q.lap === lap);
      return { code: info.get(did).code, col: seriesColors[i], t: p ? p.t : null };
    }).filter((r) => r.t).sort((a, b) => a.t - b.t);
    const html = `<b>Lap ${lap}</b><br>` + rows.map((r) => `<span class="tv" style="color:${r.col}">${esc(r.code)}</span> ${fmtLap(r.t)}`).join("<br>");
    showTip(html, e);
  });
  overlay.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
  svg.appendChild(overlay);

  host.innerHTML = ""; host.appendChild(svg);
  legendHost.innerHTML = drivers.map((did, i) => `<span><i style="background:${seriesColors[i]}"></i>${esc(info.get(did).name)}</span>`).join("");
}

/* ---- Pit-stop strategy: stint bars ---- */
function drawStints(host, results, pitsByDriver, byDriver, lastLap) {
  const rows = results.map((r) => {
    const did = r.Driver.driverId;
    const laps = byDriver.get(did);
    const finishedLap = laps ? laps[laps.length - 1].lap : lastLap;
    const stops = (pitsByDriver.get(did) || []).map((p) => p.lap).sort((a, b) => a - b);
    const bounds = [0, ...stops, finishedLap];
    const stints = [];
    for (let i = 1; i < bounds.length; i++) { const len = bounds[i] - bounds[i - 1]; if (len > 0) stints.push(len); }
    return { team: r.Constructor.name, code: driverCode(r.Driver), stints, total: finishedLap };
  });
  const maxLaps = Math.max(1, ...rows.map((r) => r.total));
  host.innerHTML = `<div class="stint-chart">` + rows.map((r) => `
      <div class="stint-row">
        <span class="stint-row__label"><i class="bar" style="--team:${teamColor(r.team)}"></i>${esc(r.code)}</span>
        <span class="stint-bar" style="width:${(r.total / maxLaps) * 100}%">
          ${r.stints.map((len, i) => `<span class="stint-seg s${i % 4}" style="flex:${len}" title="${len} laps">${len >= 4 ? len : ""}</span>`).join("")}
        </span>
      </div>`).join("") + `</div>`;
}

/* ---- Driver analysis table ---- */
function fillAnalysisTable(tbody, results, info, pace, pitsByDriver, fastestStop) {
  tbody.innerHTML = results.map((r) => {
    const did = r.Driver.driverId, v = info.get(did), ps = pace.get(did) || {};
    const delta = v.dnf ? null : v.grid - v.finish;
    const deltaHTML = delta == null ? `<span class="status-dnf">DNF</span>`
      : delta > 0 ? `<span class="mover-val up">+${delta}</span>`
      : delta < 0 ? `<span class="mover-val down">${delta}</span>` : `<span class="mover-val zero">0</span>`;
    const stops = (pitsByDriver.get(did) || []).length;
    const stopsHTML = fastestStop.did === did ? `<span title="Fastest pit stop of the race">${stops}*</span>` : String(stops);
    const posClass = ["", "p1", "p2", "p3"][v.finish] || "";
    return `
      <tr>
        <td class="pos-cell ${posClass}">${esc(r.positionText)}</td>
        <td><span class="driver-cell"><a href="#/driver/${encodeURIComponent(did)}">${esc(v.name)}</a> <span class="code">${esc(v.code)}</span></span></td>
        <td><span class="team-tag"><i class="bar" style="--team:${v.color}"></i>${esc(v.team.replace(/ F1 Team$/, ""))}</span></td>
        <td class="num">${v.grid}</td>
        <td class="num">${deltaHTML}</td>
        <td class="num">${fmtLap(ps.best)}</td>
        <td class="num">${fmtLap(ps.median)}</td>
        <td class="num">${ps.sd != null ? "±" + ps.sd.toFixed(2) + "s" : "—"}</td>
        <td class="num">${stopsHTML}</td>
        <td class="num"><span class="pts-badge">${v.points}</span></td>
      </tr>`;
  }).join("");
}

/* ============================================================
   TITLE FORECAST
   Projects the drivers' championship by Monte-Carlo simulation:
   resample each driver's own per-race points over the remaining
   rounds, thousands of times, to estimate final points and the
   probability of each outcome. A projection, not a prediction —
   it assumes future form resembles the season so far.
   ============================================================ */
let seasonRacesCache = null;
let allResultsCache = null;
let FC = null; // cached forecast inputs, so what-if scenarios re-run without re-fetching

/* Every race of the season with its full classification, in round order */
async function getSeasonRaces() {
  if (seasonRacesCache) return seasonRacesCache;
  const byRound = new Map();
  const ingest = (resp) => {
    for (const race of resp.MRData.RaceTable.Races) {
      const have = byRound.get(race.round);   // a page boundary can split one race's results
      if (have) have.Results.push(...race.Results);
      else byRound.set(race.round, { ...race, Results: [...race.Results] });
    }
  };
  const first = await getJSON(`current/results.json?limit=${PAGE}&offset=0`);
  const total = Number(first.MRData.total) || 0;
  ingest(first);
  for (let off = PAGE; off < total; off += PAGE) ingest(await getJSON(`current/results.json?limit=${PAGE}&offset=${off}`));
  seasonRacesCache = [...byRound.values()].sort((a, b) => a.round - b.round);
  return seasonRacesCache;
}
async function getAllResults() {
  if (allResultsCache) return allResultsCache;
  const races = await getSeasonRaces();
  const pointsByDriver = new Map();
  for (const race of races) {
    for (const r of race.Results) {
      const did = r.Driver.driverId;
      if (!pointsByDriver.has(did)) pointsByDriver.set(did, []);
      pointsByDriver.get(did).push(Number(r.points));
    }
  }
  allResultsCache = { pointsByDriver, rounds: races.map((r) => Number(r.round)) };
  return allResultsCache;
}

const WIN_POINTS = 25; // points for winning a race (the +100% target)
/* Bootstrap Monte-Carlo: each remaining race draws from a driver's own history.
   `skew` optionally blends a driver's sampled points toward winning every race
   (s = +1) or scoring nothing (s = -1); s = 0 is their recorded form. */
function simulateSeason(drivers, remaining, N, skew) {
  const stat = new Map(drivers.map((d) => [d.did, { champ: 0, top3: 0, finals: new Float64Array(N) }]));
  for (let s = 0; s < N; s++) {
    const finals = drivers.map((d) => {
      const h = d.history.length ? d.history : [0];
      const g = (skew && skew.get(d.did)) || 0;
      let add = 0;
      for (let k = 0; k < remaining; k++) {
        let v = h[(Math.random() * h.length) | 0];
        if (g > 0) v = v + g * (WIN_POINTS - v);       // toward winning every race
        else if (g < 0) v = v * (1 + g);               // toward zero points
        if (g !== 0) v = Math.min(WIN_POINTS, Math.max(0, Math.round(v)));
        add += v;
      }
      return { did: d.did, pts: d.current + add };
    });
    finals.sort((a, b) => b.pts - a.pts);
    stat.get(finals[0].did).champ++;
    for (let i = 0; i < 3 && i < finals.length; i++) stat.get(finals[i].did).top3++;
    for (const f of finals) stat.get(f.did).finals[s] = f.pts;
  }
  const out = new Map();
  for (const [did, st] of stat) {
    const arr = st.finals; arr.sort();
    const q = (p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    out.set(did, { pChamp: st.champ / N, pTop3: st.top3 / N, p10: q(0.1), p50: q(0.5), p90: q(0.9) });
  }
  return out;
}

async function renderForecast() {
  showLoader("Running championship simulations…");
  try {
    const [standData, schedule, lastData, all] = await Promise.all([
      getJSON("current/driverstandings.json"),
      getJSON("current.json"),
      getJSON("current/last/results.json"),
      getAllResults(),
    ]);
    const list = standData.MRData.StandingsTable.StandingsLists[0];
    if (!list) { view.innerHTML = `<p class="empty-note">Standings aren't available yet.</p>`; return; }
    const season = standData.MRData.StandingsTable.season;
    const totalRounds = schedule.MRData.RaceTable.Races.length;
    const lastRound = Number(lastData.MRData.RaceTable.Races[0]?.round) || all.rounds[all.rounds.length - 1] || 0;
    const remaining = Math.max(0, totalRounds - lastRound);
    const MAX_PER_RACE = WIN_POINTS; // no fastest-lap point since 2025
    const available = remaining * MAX_PER_RACE;

    const drivers = list.DriverStandings.map((s) => ({
      did: s.Driver.driverId, name: fullName(s.Driver), code: driverCode(s.Driver),
      team: s.Constructors[s.Constructors.length - 1]?.name || "", color: teamColor(s.Constructors[s.Constructors.length - 1]?.name),
      current: Number(s.points), pos: Number(s.position), wins: Number(s.wins),
      history: all.pointsByDriver.get(s.Driver.driverId) || [],
    }));
    const leader = drivers[0], second = drivers[1];
    const margin = second ? leader.current - second.current : leader.current;
    const clinched = remaining === 0 || (second && margin > available);

    // the races still to come, for the per-driver points table
    const remainingRaces = schedule.MRData.RaceTable.Races
      .filter((r) => Number(r.round) > lastRound)
      .map((r) => ({ round: Number(r.round), name: r.raceName.replace(/ Grand Prix$/, " GP") }));

    FC = { drivers, remaining, remainingRaces, totalRounds, available, season, leader, margin, clinched, racesSampled: all.rounds.length };

    const statusHTML = clinched
      ? `<span class="status-pill clinched">Title clinched by ${esc(leader.name)}</span>`
      : `<span class="status-pill open">Title still open, ${remaining} round${remaining === 1 ? "" : "s"} left</span>`;

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(season)} title forecast</h1>
        <p class="sub">${statusHTML}</p>
      </div>

      ${remaining > 0 ? `
      <div class="scenario-bar">
        <div class="scenario-bar__head">
          <span class="scenario-bar__title">What-if scenario</span>
          <span class="scenario-note" id="scenarioNote"></span>
        </div>
        <div class="scenario-rows" id="scenarioRows"></div>
        <button class="add-btn" id="addScenario" type="button">+ Add driver</button>
      </div>` : ""}

      <div class="kpi-row">
        <div class="kpi"><div class="k">Rounds left</div><div class="v">${remaining}</div><div class="meta2">of ${totalRounds}</div></div>
        <div class="kpi"><div class="k">Points still available</div><div class="v">${available}</div><div class="meta2">max ${MAX_PER_RACE}/race</div></div>
        <div class="kpi"><div class="k">Leader</div><div class="v">${esc(leader.code)}</div><div class="meta2">${leader.current} pts</div></div>
        <div class="kpi"><div class="k">Lead margin</div><div class="v">${margin}</div><div class="meta2">over P2</div></div>
      </div>

      <div class="dash-grid">
        <div class="chart-card">
          <h3>Title probability</h3>
          <p class="csub">Share of 5,000 simulated seasons each driver wins the title.</p>
          <div class="bar-list" id="probBars" style="margin-top:8px"></div>
        </div>
        <div class="chart-card">
          <h3>How this works</h3>
          <div class="assume">
            For every remaining round, each driver draws a points score at random from
            <b>their own results this season</b>, repeated <b>5,000 times</b>. The spread of those
            simulated seasons gives the projected final points (median, with a P10–P90 range) and
            each driver's title chance.
            <br><br>
            The <b>what-if</b> sliders drag a driver from <b>−100%</b> (scores nothing) through their
            recorded form to <b>+100%</b> (wins every remaining race), so you can watch the standings
            re-shuffle. It otherwise assumes future form resembles the season so far — a
            <b>projection</b>, not a prediction.
          </div>
        </div>

        <div class="span-2" id="remainPts"></div>

        <div class="span-2">
          <h2 class="section-title" style="margin-top:6px">Projected final standings</h2>
          <div class="table-wrap">
            <table class="grid">
              <thead><tr>
                <th>Proj.</th><th>Move</th><th>Driver</th><th>Team</th>
                <th class="num">Now</th><th class="num">Proj. pts</th><th class="num">Range (P10–P90)</th><th class="num">Title&nbsp;%</th>
              </tr></thead>
              <tbody id="projBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <p class="pipeline">
        5,000 simulations of ${remaining} round${remaining === 1 ? "" : "s"}, resampling ${all.rounds.length} races
        for ${drivers.length} drivers, run in your browser. Source: ${sourceName()}.
      </p>
    `;

    const addBtn = $("#addScenario");
    if (addBtn) {
      addBtn.addEventListener("click", () => { addScenarioRow(); });
      addScenarioRow(); // start with one empty row
    }
    renderScenario();
  } catch (err) { showError(err); }
}

const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function scenarioDriverOptions(sel) {
  return `<option value="">— Select a driver —</option>` +
    FC.drivers.map((d) => `<option value="${esc(d.did)}" ${d.did === sel ? "selected" : ""}>${esc(d.name)}</option>`).join("");
}
/* label beside the slider — s is the integer percentage (-100..100) */
function sliderLabel(s) {
  if (s === 0) return "0% · as recorded";
  if (s === 100) return "+100% · wins every race";
  if (s === -100) return "−100% · scores nothing";
  return (s > 0 ? "+" : "−") + Math.abs(s) + "% · " + (s > 0 ? "stronger" : "weaker");
}
/* expected points per remaining race for a driver under a blend s (-1..1) */
function expectedPerRace(history, s) {
  const mean = history.length ? history.reduce((a, b) => a + b, 0) / history.length : 0;
  if (s > 0) return mean + s * (WIN_POINTS - mean);
  if (s < 0) return mean * (1 + s);
  return mean;
}

/* Append one driver/slider row to the what-if list */
function addScenarioRow(did = "", sPct = 0) {
  const host = $("#scenarioRows");
  if (!host || !FC) return;
  const row = document.createElement("div");
  row.className = "scenario-row";
  row.innerHTML = `
    <div class="round-select-wrap scenario-row__driver">
      <select class="round-select scenario-driver" aria-label="Driver">${scenarioDriverOptions(did)}</select>${CHEVRON}
    </div>
    <div class="slider-wrap">
      <input class="scenario-slider" type="range" min="-100" max="100" step="5" value="${sPct}" aria-label="Performance">
      <span class="slider-val">${sliderLabel(sPct)}</span>
    </div>
    <button class="row-remove" type="button" aria-label="Remove driver" title="Remove">×</button>`;
  host.appendChild(row);
  const slider = row.querySelector(".scenario-slider"), val = row.querySelector(".slider-val");
  row.querySelector(".scenario-driver").addEventListener("change", renderScenario);
  slider.addEventListener("input", () => { val.textContent = sliderLabel(parseInt(slider.value, 10)); });
  slider.addEventListener("change", renderScenario);
  row.querySelector(".row-remove").addEventListener("click", () => { row.remove(); renderScenario(); });
}

/* Re-run the simulation for the chosen what-ifs and repaint the dynamic sections */
function renderScenario() {
  if (!FC) return;
  const probHost = $("#probBars"), body = $("#projBody"), note = $("#scenarioNote");
  if (!probHost || !body) return;

  // collect every row: selMap keeps each chosen driver (last slider wins),
  // skew holds only drivers moved off their recorded form.
  const selMap = new Map(); // did -> s (-1..1)
  document.querySelectorAll(".scenario-row").forEach((r) => {
    const did = r.querySelector(".scenario-driver").value;
    const s = parseInt(r.querySelector(".scenario-slider").value, 10) / 100;
    if (did) selMap.set(did, s);
  });
  const skew = new Map();
  selMap.forEach((s, did) => { if (s !== 0) skew.set(did, s); });
  const active = skew.size > 0;

  const sim = FC.remaining > 0 ? simulateSeason(FC.drivers, FC.remaining, 5000, skew) : null;

  // ---- points from the remaining races, for the selected drivers ----
  renderRemainingPoints(selMap);

  // title-probability bars
  const contenders = sim
    ? FC.drivers.map((d) => ({ ...d, ...sim.get(d.did) })).filter((d) => d.pChamp >= 0.002).sort((a, b) => b.pChamp - a.pChamp)
    : [];
  probHost.innerHTML = contenders.length ? contenders.map((d) => {
    const pct = d.pChamp * 100;
    const hi = skew.has(d.did) ? ' class="skew-hi"' : "";
    return `
      <div class="bar-row"${hi} style="--team:${d.color}">
        <span class="bar-row__label" title="${esc(d.name)}">${esc(d.code)} · ${esc(d.name.split(" ").slice(-1)[0])}</span>
        <span class="bar-row__track"><span class="bar-row__fill" style="width:${Math.max(1, pct)}%;--bc:${d.color}"></span></span>
        <span class="bar-row__val prob-pct">${pct >= 9.95 ? pct.toFixed(0) : pct.toFixed(1)}%</span>
      </div>`;
  }).join("") : `<p class="empty-note">${FC.clinched ? "The title is mathematically settled." : "No remaining rounds to simulate."}</p>`;

  // projected standings, ranked by projected points
  const ranked = FC.drivers.map((d) => {
    const f = sim?.get(d.did);
    return { ...d, proj: f ? f.p50 : d.current, p10: f ? f.p10 : d.current, p90: f ? f.p90 : d.current, pChamp: f ? f.pChamp : (d.pos === 1 && FC.clinched ? 1 : 0) };
  }).sort((a, b) => b.proj - a.proj || b.current - a.current);

  body.innerHTML = ranked.map((d, i) => {
    const projPos = i + 1;
    const mv = d.pos - projPos;
    const mvHTML = mv > 0 ? `<span class="mover-val up">▲${mv}</span>` : mv < 0 ? `<span class="mover-val down">▼${-mv}</span>` : `<span class="mover-val zero">–</span>`;
    const champPct = d.pChamp * 100;
    const champStr = champPct >= 99.95 ? "100%" : champPct >= 9.95 ? champPct.toFixed(0) + "%" : champPct >= 0.05 ? champPct.toFixed(1) + "%" : "—";
    const posClass = ["", "p1", "p2", "p3"][projPos] || "";
    const hi = skew.has(d.did) ? ' class="skew-hi"' : "";
    return `
      <tr${hi} style="--team:${d.color}">
        <td class="pos-cell ${posClass}">${projPos}</td>
        <td>${mvHTML}</td>
        <td><span class="driver-cell"><a href="#/driver/${encodeURIComponent(d.did)}">${esc(d.name)}</a></span></td>
        <td><span class="team-tag"><i class="bar" style="--team:${d.color}"></i>${esc(d.team.replace(/ F1 Team$/, ""))}</span></td>
        <td class="num">${d.current}</td>
        <td class="num">${d.proj}</td>
        <td class="num"><span class="proj-range">${d.p10}–${d.p90}</span></td>
        <td class="num prob-pct">${champStr}</td>
      </tr>`;
  }).join("");

  if (note) {
    note.innerHTML = active
      ? "Applied: " + [...skew].map(([did, s]) => {
          const d = FC.drivers.find((x) => x.did === did);
          return `<b style="color:${d.color}">${esc(d.code)}</b> ${s > 0 ? "+" : "−"}${Math.round(Math.abs(s) * 100)}%`;
        }).join(", ") + " — re-simulated."
      : `Baseline projection. Add a driver and drag the slider to run a what-if.`;
  }
}

/* Table: points each selected driver is projected to score in the remaining races */
function renderRemainingPoints(selMap) {
  const host = $("#remainPts");
  if (!host || !FC) return;
  const title = `<h2 class="section-title" style="margin-top:6px">Points from the remaining races</h2>`;
  if (selMap.size === 0) {
    host.innerHTML = `${title}<p class="empty-note">Pick a driver above to project how many points they'll score across the ${FC.remaining} remaining round${FC.remaining === 1 ? "" : "s"}.</p>`;
    return;
  }
  const head = `<th>Driver</th>` +
    FC.remainingRaces.map((r) => `<th class="num" title="${esc(r.name)}">R${r.round}</th>`).join("") +
    `<th class="num">Total</th>`;
  const rows = [...selMap].map(([did, s]) => {
    const d = FC.drivers.find((x) => x.did === did);
    if (!d) return "";
    const per = Math.round(expectedPerRace(d.history, s));
    const cells = FC.remainingRaces.map(() => `<td class="num">${per}</td>`).join("");
    const total = per * FC.remainingRaces.length;
    const tag = s === 0 ? "" : s > 0 ? ` <span class="mover-val up">+${Math.round(s * 100)}%</span>` : ` <span class="mover-val down">${Math.round(s * 100)}%</span>`;
    return `
      <tr style="--team:${d.color}">
        <td><span class="team-tag"><i class="bar" style="--team:${d.color}"></i>${esc(d.name)}</span>${tag}</td>
        ${cells}
        <td class="num"><b>${total}</b></td>
      </tr>`;
  }).join("");
  host.innerHTML = `
    ${title}
    <div class="table-wrap"><table class="grid">
      <thead><tr>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="empty-note" style="font-size:12px">Projected average points per round under the slider — at +100% the driver wins every race (${WIN_POINTS} pts each), at −100% they score nothing. Rounds: ${FC.remainingRaces.map((r) => `R${r.round} ${esc(r.name)}`).join(" · ")}.</p>`;
}

/* ============================================================
   CHAMPION
   The season of the drivers' champion: headline numbers, then an
   exploratory analysis (EDA) built in the browser from the season's
   results, each round's qualifying and standings, and the champion's
   own lap-by-lap positions. Shown only while CHAMPION.confirmed.
   ============================================================ */
const SPRINT_WIN_POINTS = 8;
function championVisible(season) { return CHAMPION.confirmed && String(season) === CHAMPION.season; }

/* Fetch many paths a few at a time, to stay under the live API's rate limit.
   A path that fails gives null. */
async function getEach(paths, onProgress) {
  const out = new Array(paths.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      out[i] = await getJSON(paths[i]).catch(() => null);
      onProgress?.(++done, paths.length);
    }
  };
  await Promise.all(Array.from({ length: DATA.mode === "live" ? 2 : 6 }, worker));
  return out;
}

function describe(values) {
  const v = values.filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return null;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, median, sd, min: v[0], max: v[n - 1] };
}
function pearson(pairs) {
  if (pairs.length < 3) return null;
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
/* seconds between two qualifying entries, in the last session both set a time in */
function qualiGap(a, b) {
  for (const k of ["Q3", "Q2", "Q1"]) {
    const ta = toSec(a?.[k]), tb = toSec(b?.[k]);
    if (ta && tb) return ta - tb;
  }
  return null;
}
function longestRun(flags) {
  let best = 0, run = 0;
  for (const f of flags) { run = f ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}
const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
const shortGP = (name) => name.replace(/ Grand Prix$/, "");

/* One row per round the champion raced, plus the standings after every round */
function championSeason(did, schedule, races, standRounds, qualRounds, lapRounds) {
  const rows = [], tables = new Map(), sprintRounds = new Set();
  let prev = new Map();
  races.forEach((race, i) => {
    const round = Number(race.round);
    const list = standRounds[i]?.MRData.StandingsTable.StandingsLists[0]?.DriverStandings || [];
    const table = new Map(list.map((s) => [s.Driver.driverId, Number(s.points)]));
    tables.set(round, table);
    // standings points gained beyond the Grand Prix's own points came from a sprint
    const gpPoints = sum(race.Results.map((r) => Number(r.points)));
    let gained = 0;
    table.forEach((p, d) => { gained += p - (prev.get(d) || 0); });
    if (table.size && gained - gpPoints > 0.5) sprintRounds.add(round);

    const res = race.Results.find((r) => r.Driver.driverId === did);
    if (res) {
      const N = race.Results.length;
      const quali = qualRounds[i]?.MRData.RaceTable.Races[0]?.QualifyingResults || [];
      const q = quali.find((x) => x.Driver.driverId === did);
      const poleQ = quali.find((x) => x.position === "1");
      const mateRes = race.Results.find((r) => r.Constructor.constructorId === res.Constructor.constructorId && r.Driver.driverId !== did);
      const mateQ = mateRes && quali.find((x) => x.Driver.driverId === mateRes.Driver.driverId);
      const laps = lapRounds[i]?.MRData.RaceTable.Races[0]?.Laps || [];
      const pos = laps.map((l) => Number(l.Timings[0]?.position)).filter(Boolean);
      const finish = Number(res.position), p2 = race.Results.find((r) => r.position === "2");
      const gap = q && poleQ ? qualiGap(q, poleQ) : null;
      const total = table.get(did);
      const rivals = [...table].filter(([d]) => d !== did).map(([, p]) => p);
      rows.push({
        round, name: shortGP(race.raceName), raceName: race.raceName,
        grid: Number(res.grid) || N, gridText: res.grid === "0" ? "Pit lane" : `P${res.grid}`,
        finish, finishText: res.positionText, status: res.status, dnf: isDNF(res.status),
        points: Number(res.points), fl: res.FastestLap?.rank === "1",
        quali: q ? Number(q.position) : null,
        pole: q ? q.position === "1" : res.grid === "1",
        qGap: gap == null ? null : Math.max(0, gap),
        mate: mateRes ? {
          did: mateRes.Driver.driverId, name: fullName(mateRes.Driver), code: driverCode(mateRes.Driver),
          quali: mateQ ? Number(mateQ.position) : null, finish: Number(mateRes.position),
          dnf: isDNF(mateRes.status), points: Number(mateRes.points),
        } : null,
        lapsLed: pos.length ? pos.filter((p) => p === 1).length : null,
        bands: [pos.filter((p) => p === 1).length, pos.filter((p) => p === 2 || p === 3).length,
                pos.filter((p) => p >= 4 && p <= 10).length, pos.filter((p) => p > 10).length],
        raceLaps: Number(race.Results[0].laps) || null,
        margin: finish === 1 && p2?.Time ? toSec(p2.Time.time.replace(/^\+/, "")) : null,
        total: total ?? null,
        champPos: Number(list.find((s) => s.Driver.driverId === did)?.position) || null,
        lead: total != null && rivals.length ? total - Math.max(...rivals) : null,
        sprintPts: total != null ? total - (prev.get(did) || 0) - Number(res.points) : null,
      });
    }
    if (table.size) prev = table;
  });

  // points a rival could still score after each round: every Grand Prix and sprint left
  const totalRounds = schedule.MRData.RaceTable.Races.length;
  const lastRound = races.length ? Number(races[races.length - 1].round) : 0;
  schedule.MRData.RaceTable.Races.forEach((r) => { if (Number(r.round) > lastRound && r.Sprint) sprintRounds.add(Number(r.round)); });
  rows.forEach((r) => {
    r.sprint = sprintRounds.has(r.round);
    r.avail = WIN_POINTS * (totalRounds - r.round) + SPRINT_WIN_POINTS * [...sprintRounds].filter((k) => k > r.round).length;
  });
  const clinch = rows.find((r) => r.champPos === 1 && r.lead != null && r.lead > r.avail) || null;
  return { rows, tables, clinch, totalRounds, sprintRounds };
}

async function renderChampion() {
  view.innerHTML = `<div class="loader"><span class="loader__spin"></span> Loading the champion's season…</div><div class="dash-progress" id="champProgress"></div>`;
  try {
    const [standData, schedule, races] = await Promise.all([
      getJSON("current/driverstandings.json"), getJSON("current.json"), getSeasonRaces(),
    ]);
    const season = standData.MRData.StandingsTable.season;
    const list = standData.MRData.StandingsTable.StandingsLists[0];
    if (!list || !championVisible(season) || !races.length) {
      view.innerHTML = `<p class="empty-note">This page opens once the ${esc(season)} drivers' title has been decided.</p>`;
      return;
    }
    const champ = list.DriverStandings[0], second = list.DriverStandings[1];
    const did = champ.Driver.driverId, drv = champ.Driver;
    const team = champ.Constructors[champ.Constructors.length - 1]?.name || "";

    const rounds = races.map((r) => r.round);
    const prog = $("#champProgress");
    const fetched = await getEach([
      ...rounds.map((r) => `current/${r}/driverstandings.json`),
      ...rounds.map((r) => `current/${r}/qualifying.json?limit=${PAGE}`),
      ...rounds.map((r) => `current/${r}/drivers/${encodeURIComponent(did)}/laps.json?limit=${PAGE}`),
    ], (done, all) => { if (prog) prog.textContent = `Loading round data… ${done} / ${all}`; });
    const k = rounds.length;
    const S = championSeason(did, schedule, races, fetched.slice(0, k), fetched.slice(k, 2 * k), fetched.slice(2 * k));
    const { rows, clinch, totalRounds } = S;
    const n = rows.length;

    // ---- headline numbers ----
    const wins = rows.filter((r) => r.finish === 1 && !r.dnf);
    const poles = rows.filter((r) => r.pole);
    const polesWon = poles.filter((r) => r.finish === 1).length;
    const podiums = rows.filter((r) => r.finish <= 3 && !r.dnf).length;
    const withLaps = rows.filter((r) => r.lapsLed != null);
    const lapsLed = sum(withLaps.map((r) => r.lapsLed)), raceLaps = sum(withLaps.map((r) => r.raceLaps));
    const lapsRun = sum(withLaps.map((r) => sum(r.bands)));
    const racesLed = withLaps.filter((r) => r.lapsLed > 0).length;
    const fastestLaps = rows.filter((r) => r.fl).length;
    const hatTricks = rows.filter((r) => r.pole && r.finish === 1 && r.fl).length;
    const grandSlams = rows.filter((r) => r.pole && r.finish === 1 && r.fl && r.lapsLed != null && r.lapsLed === r.raceLaps).length;
    const frontRows = rows.filter((r) => r.grid <= 2).length;
    const classified = rows.filter((r) => !r.dnf);
    const dnfs = rows.filter((r) => r.dnf && !isDNS(r.status)).length;
    const sprintPts = sum(rows.map((r) => r.sprintPts));
    const comeback = wins.reduce((b, r) => (!b || r.grid > b.grid ? r : b), null);
    const winStreak = longestRun(rows.map((r) => r.finish === 1 && !r.dnf));
    const leading = rows.filter((r) => r.champPos === 1).length;
    const margin = second ? Number(champ.points) - Number(second.points) : null;
    const avgFinish = describe(classified.map((r) => r.finish))?.mean;
    const avgGrid = describe(rows.map((r) => r.grid))?.mean;
    const fmt1 = (v) => (v == null ? "—" : v.toFixed(1));

    const clinchLine = clinch
      ? `Clinched at the ${esc(clinch.raceName)}, round ${clinch.round}, ${totalRounds - clinch.round > 0
          ? `with ${totalRounds - clinch.round} round${totalRounds - clinch.round === 1 ? "" : "s"} to spare` : "the final round"}.`
      : "Title confirmed.";

    const tiles = [
      ["Points", champ.points, margin != null ? `${margin} ahead of ${esc(fullName(second.Driver))}` : ""],
      ["Wins", wins.length, `${pct(wins.length, n)} of ${n} races`],
      ["Podiums", podiums, `${pct(podiums, n)} of races`],
      ["Pole positions", poles.length, `${frontRows} front-row starts`],
      ["Poles converted", `${polesWon}/${poles.length}`, `${pct(polesWon, poles.length)} of poles turned into wins`],
      ["Laps led", lapsLed, `${pct(lapsLed, raceLaps)} of all race laps, in ${racesLed} races`],
      ["Fastest laps", fastestLaps, `in ${pct(fastestLaps, n)} of races`],
      ["Hat-tricks", hatTricks, "pole, win and fastest lap"],
      ["Grand slams", grandSlams, "a hat-trick, leading every lap"],
      ["Sprint points", sprintPts, `from ${[...S.sprintRounds].filter((r) => r <= rows[n - 1].round).length} sprints`],
      ["Average finish", fmt1(avgFinish), `from an average grid slot of ${fmt1(avgGrid)}`],
      ["Best comeback", comeback ? comeback.gridText : "—", comeback ? `won from there at the ${esc(comeback.name)} GP` : "no wins"],
      ["Longest win streak", winStreak, winStreak === 1 ? "race" : "races in a row"],
      ["Led the championship", `${leading}/${n}`, "rounds"],
      ["Did not finish", dnfs, `${classified.length} classified finishes`],
    ];

    // ---- rivals for the points chart: the next three in the standings ----
    const contenders = list.DriverStandings.slice(0, 4).map((s, i) => ({
      did: s.Driver.driverId, code: driverCode(s.Driver), name: fullName(s.Driver),
      color: `var(--s${i + 1})`, pts: new Map([...S.tables].map(([r, t]) => [r, t.get(s.Driver.driverId) ?? null])),
    }));
    const roundNums = [...S.tables.keys()];
    const names = new Map(races.map((r) => [Number(r.round), shortGP(r.raceName)]));

    // ---- teammate (the one they shared the most races with) ----
    const mateCount = new Map();
    rows.forEach((r) => r.mate && mateCount.set(r.mate.did, (mateCount.get(r.mate.did) || 0) + 1));
    const mateId = [...mateCount].sort((a, b) => b[1] - a[1])[0]?.[0];
    const shared = rows.filter((r) => r.mate?.did === mateId);
    const mate = shared[0]?.mate;
    const qBoth = shared.filter((r) => r.quali && r.mate.quali);
    const rBoth = shared.filter((r) => !r.dnf && !r.mate.dnf);
    const mateStanding = list.DriverStandings.find((s) => s.Driver.driverId === mateId);
    const h2h = mate ? [
      ["Qualifying", qBoth.filter((r) => r.quali < r.mate.quali).length, qBoth.filter((r) => r.mate.quali < r.quali).length],
      ["Race, both finished", rBoth.filter((r) => r.finish < r.mate.finish).length, rBoth.filter((r) => r.mate.finish < r.finish).length],
      ["Wins", shared.filter((r) => r.finish === 1 && !r.dnf).length, shared.filter((r) => r.mate.finish === 1 && !r.mate.dnf).length],
      ["Podiums", shared.filter((r) => r.finish <= 3 && !r.dnf).length, shared.filter((r) => r.mate.finish <= 3 && !r.mate.dnf).length],
      ["Championship points", Number(champ.points), mateStanding ? Number(mateStanding.points) : "—"],
    ] : [];

    // ---- summary statistics ----
    const statRows = [
      ["Qualifying position", rows.map((r) => r.quali), 1],
      ["Grid position", rows.map((r) => r.grid), 1],
      ["Finishing position, classified", classified.map((r) => r.finish), 1],
      ["Positions gained, classified", classified.map((r) => r.grid - r.finish), 1],
      ["Points per Grand Prix", rows.map((r) => r.points), 1],
      ["Laps led per race", rows.map((r) => r.lapsLed), 1],
      ["Gap to pole (s)", rows.map((r) => r.qGap), 3],
      ["Winning margin (s)", rows.map((r) => r.margin), 3],
    ];
    const rGridFinish = pearson(classified.map((r) => [r.grid, r.finish]));
    const fromPole = describe(rows.filter((r) => r.grid === 1).map((r) => r.points));
    const fromElse = describe(rows.filter((r) => r.grid !== 1).map((r) => r.points));
    const winMargin = describe(wins.map((r) => r.margin));

    view.innerHTML = `
      <header class="page-head">
        <p class="eyebrow">${esc(season)} Formula 1 World Champion</p>
        <h1 class="champ-name">${esc(fullName(drv))}</h1>
        <p class="sub"><span class="team-tag" style="--team:${teamColor(team)}"><i class="bar"></i>${esc(team)}</span> · ${clinchLine}</p>
      </header>

      <nav class="toc" aria-label="On this page">
        <button type="button" data-jump="ch-title">Title race</button>
        <button type="button" data-jump="ch-races">Races</button>
        <button type="button" data-jump="ch-quali">Qualifying</button>
        <button type="button" data-jump="ch-stats">Statistics</button>
        <button type="button" data-jump="ch-log">Race by race</button>
      </nav>

      <div class="stat-row">
        ${tiles.map(([kk, v, d]) => `<div class="stat-tile"><div class="k">${kk}</div><div class="v">${esc(v)}</div>${d ? `<div class="d">${d}</div>` : ""}</div>`).join("")}
      </div>

      <h2 class="section-title" id="ch-title">The title race</h2>
      <p class="prose">An exploratory look at the ${esc(season)} season, from ${n} Grands Prix, the standings after each round and ${lapsRun.toLocaleString()} of ${esc(drv.familyName)}'s laps.</p>
      <div class="dash-grid" style="margin-top:0">
        <div class="chart-card span-2">
          <h3>Championship points after each round</h3>
          <p class="csub">${esc(drv.familyName)} against the next three drivers in the standings.</p>
          <div class="chart-legend">${contenders.map((c) => `<span><i style="border-color:${c.color}"></i>${esc(c.name)}</span>`).join("")}</div>
          <div class="chart" id="chPoints"></div>
        </div>
        <div class="chart-card span-2">
          <h3>Lead against the points still available</h3>
          <p class="csub">The title is settled once the lead over second place is bigger than the points a rival could still score.</p>
          <div class="chart-legend">
            <span><i class="box" style="background:var(--s1)"></i>Lead over second place</span>
            <span><i style="border-color:var(--s2)"></i>Points still available</span>
          </div>
          <div class="chart" id="chClinch"></div>
        </div>
      </div>

      <h2 class="section-title" id="ch-races">Races</h2>
      <div class="dash-grid" style="margin-top:0">
        <div class="chart-card span-2">
          <h3>Grid to finish, every race</h3>
          <p class="csub">Lines run from the starting slot to the finishing position. Higher is better.</p>
          <div class="chart-legend">
            <span><i class="ring"></i>Grid</span>
            <span><i class="dot" style="background:var(--s1)"></i>Finish</span>
            <span><i class="dot" style="background:var(--faint)"></i>Did not finish</span>
          </div>
          <div class="chart" id="chGrid"></div>
        </div>
        <div class="chart-card">
          <h3>Finishing positions</h3>
          <p class="csub">How often each result came up, out of ${n} races.</p>
          <div id="chDist"></div>
        </div>
        <div class="chart-card">
          <h3>Where the laps were spent</h3>
          <p class="csub">Track position across every lap raced.</p>
          <div id="chBands"></div>
        </div>
        <div class="chart-card">
          <h3>Laps led per race</h3>
          <p class="csub">Bar length is the share of the race spent in front.</p>
          <div id="chLed"></div>
        </div>
        <div class="chart-card">
          <h3>Teammate head-to-head</h3>
          <p class="csub">${mate ? `${esc(mate.name)}, across ${shared.length} races together.` : "No teammate data."}</p>
          ${mate ? `<table class="grid compact h2h">
            <thead><tr><th></th><th class="num">${esc(driverCode(drv))}</th><th class="num">${esc(mate.code)}</th></tr></thead>
            <tbody>${h2h.map(([label, a, b]) => `<tr><td>${label}</td><td class="num${a > b ? " win" : ""}">${a}</td><td class="num${b > a ? " win" : ""}">${b}</td></tr>`).join("")}</tbody>
          </table>` : ""}
        </div>
      </div>

      <h2 class="section-title" id="ch-quali">Qualifying</h2>
      <div class="chart-card">
        <h3>Gap to pole position</h3>
        <p class="csub">Seconds behind the pole time, in the last session both drivers set a time in. Dots on the baseline are the ${poles.length} pole positions.</p>
        <div class="chart" id="chQuali"></div>
      </div>

      <h2 class="section-title" id="ch-stats">Summary statistics</h2>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Measure</th><th class="num">Races</th><th class="num">Mean</th><th class="num">Median</th><th class="num">Std dev</th><th class="num">Min</th><th class="num">Max</th></tr></thead>
          <tbody>${statRows.map(([label, vals, dp]) => {
            const d = describe(vals);
            const f = (v) => (d ? v.toFixed(Number.isInteger(v) && dp === 1 ? 0 : dp) : "—");
            return `<tr><td>${label}</td><td class="num">${d ? d.n : 0}</td><td class="num">${d ? d.mean.toFixed(dp) : "—"}</td><td class="num">${d ? f(d.median) : "—"}</td><td class="num">${d ? d.sd.toFixed(dp) : "—"}</td><td class="num">${d ? f(d.min) : "—"}</td><td class="num">${d ? f(d.max) : "—"}</td></tr>`;
          }).join("")}</tbody>
        </table>
      </div>
      <ul class="limits findings">
        ${rGridFinish != null ? `<li>Grid slot and finishing position correlate at <b>r = ${rGridFinish.toFixed(2)}</b> over classified finishes${Math.abs(rGridFinish) < 0.3 ? ", so the starting slot said little about the result" : ""}.</li>` : ""}
        ${fromPole && fromElse ? `<li>${esc(drv.familyName)} scored <b>${fromPole.mean.toFixed(1)}</b> points a race starting from pole (${fromPole.n} starts) and <b>${fromElse.mean.toFixed(1)}</b> from anywhere else (${fromElse.n} starts).</li>` : ""}
        ${winMargin ? `<li>The median winning margin was <b>${winMargin.median.toFixed(3)} s</b>, and the closest win was by ${winMargin.min.toFixed(3)} s.</li>` : ""}
        ${sprintPts ? `<li><b>${sprintPts}</b> of ${esc(drv.familyName)}'s ${esc(champ.points)} points (${pct(sprintPts, Number(champ.points))}) came from sprints.</li>` : ""}
      </ul>

      <h2 class="section-title" id="ch-log">Race by race</h2>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr>
            <th>Rd</th><th>Grand Prix</th><th class="num">Quali</th><th class="num">Grid</th><th class="num">Finish</th>
            <th class="num">Laps led</th><th class="num">Pts</th><th class="num">Sprint</th><th class="num">Total</th><th class="num">Lead</th>
          </tr></thead>
          <tbody>${rows.map((r) => `
            <tr${clinch && r.round === clinch.round ? ' class="is-used" title="Title clinched"' : ""}>
              <td class="mono">${r.round}</td>
              <td><a href="#/race/${r.round}">${esc(r.name)}</a></td>
              <td class="num${r.pole ? " strong" : ""}">${r.quali ?? "—"}</td>
              <td class="num">${esc(r.gridText.replace(/^P/, ""))}</td>
              <td class="num">${r.dnf ? `<span class="status-dnf">${esc(r.status)}</span>` : `<span class="${r.finish === 1 ? "strong" : ""}">${esc(r.finishText)}</span>`}${r.fl ? ` <span class="code" title="Fastest lap">FL</span>` : ""}</td>
              <td class="num">${r.lapsLed == null ? "—" : `${r.lapsLed}<span class="muted-num">/${r.raceLaps}</span>`}</td>
              <td class="num">${r.points}</td>
              <td class="num">${r.sprint ? r.sprintPts : "–"}</td>
              <td class="num"><b>${r.total ?? "—"}</b></td>
              <td class="num">${r.lead == null ? "—" : r.lead > 0 ? `+${r.lead}` : r.lead}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="table-note">FL: fastest lap. Total and lead include sprint points.${clinch ? ` The highlighted row is where the title was clinched.` : ""}</p>

      <p class="pipeline">Built in your browser from ${races.length} race classifications, ${k} qualifying sessions,
        ${k} rounds of standings and ${lapsRun.toLocaleString()} laps. Source: ${sourceName()}.</p>
    `;

    drawTitleRace($("#chPoints"), contenders, roundNums, clinch?.round, names);
    drawClinchChart($("#chClinch"), rows, clinch?.round);
    drawGridFinish($("#chGrid"), rows);
    drawPoleGap($("#chQuali"), rows);

    const dist = [
      ["Win", (r) => r.finish === 1], ["2nd", (r) => r.finish === 2], ["3rd", (r) => r.finish === 3],
      ["4th–5th", (r) => r.finish >= 4 && r.finish <= 5], ["6th–10th", (r) => r.finish >= 6 && r.finish <= 10],
      ["Outside top 10", (r) => r.finish > 10],
    ].map(([label, test]) => {
      const hit = classified.filter(test);
      return { label, value: hit.length, tip: `<b>${label}</b><br>${hit.length ? hit.map((r) => esc(r.name)).join(", ") : "none"}` };
    });
    const dnfRows = rows.filter((r) => r.dnf);
    dist.push({ label: "Did not finish", value: dnfRows.length, tip: `<b>Did not finish</b><br>${dnfRows.map((r) => `${esc(r.name)}: ${esc(r.status)}`).join("<br>") || "none"}` });
    $("#chDist").innerHTML = barList(dist, Math.max(...dist.map((d) => d.value)));

    const bandLabels = ["Leading", "2nd–3rd", "4th–10th", "11th or lower"];
    $("#chBands").innerHTML = barList(bandLabels.map((label, b) => {
      const v = sum(withLaps.map((r) => r.bands[b]));
      return { label, value: v, valText: pct(v, lapsRun), tip: `<b>${label}</b><br><span class="tv">${v}</span> of ${lapsRun} laps` };
    }), lapsRun);

    $("#chLed").innerHTML = barList(withLaps.map((r) => ({
      label: `${r.round} · ${r.name}`, value: r.lapsLed, max: r.raceLaps, valText: `${r.lapsLed}/${r.raceLaps}`,
      tip: `<b>${esc(r.raceName)}</b><br>Led <span class="tv">${r.lapsLed}</span> of ${r.raceLaps} laps · finished ${r.dnf ? esc(r.status) : "P" + r.finish}`,
    })), null, "wide");

    view.querySelectorAll("[data-tip]").forEach((el) => {
      el.addEventListener("mousemove", (e) => showTip(el.dataset.tip, e));
      el.addEventListener("mouseleave", hideTip);
    });
    wireJumpLinks();
  } catch (err) { showError(err); }
}

/* Horizontal bars with a hover note: items are { label, value, max?, valText?, tip? } */
function barList(items, max, cls = "") {
  return `<div class="bar-list">${items.map((it) => {
    const m = it.max ?? max;
    const w = m ? (it.value / m) * 100 : 0;
    return `
      <div class="bar-row ${cls}"${it.tip ? ` data-tip="${esc(it.tip)}"` : ""}>
        <span class="bar-row__label" title="${esc(it.label)}">${esc(it.label)}</span>
        <span class="bar-row__track">${w > 0 ? `<span class="bar-row__fill" style="width:${w}%"></span>` : ""}</span>
        <span class="bar-row__val">${esc(it.valText ?? it.value)}</span>
      </div>`;
  }).join("")}</div>`;
}

/* a column with a 4px rounded end away from the baseline */
function colPath(x, w, yBase, yEnd, r = 4) {
  const h = Math.abs(yEnd - yBase);
  if (h < 0.5) return "";
  r = Math.min(r, h, w / 2);
  const s = yEnd < yBase ? 1 : -1;   // 1 = grows upward
  return `M${x},${yBase} V${yEnd + s * r} Q${x},${yEnd} ${x + r},${yEnd} H${x + w - r} Q${x + w},${yEnd} ${x + w},${yEnd + s * r} V${yBase} Z`;
}
function nearestIndex(evt, svg, W, xs) {
  const b = svg.getBoundingClientRect();
  const vx = ((evt.clientX - b.left) / b.width) * W;
  let best = 0;
  xs.forEach((x, i) => { if (Math.abs(x - vx) < Math.abs(xs[best] - vx)) best = i; });
  return best;
}
function yAxis(svg, ticks, y, x1, x2, fmt = (v) => v) {
  ticks.forEach((v) => {
    svg.appendChild(svgEl("line", { class: "grid-line", x1, y1: y(v), x2, y2: y(v) }));
    const t = svgEl("text", { x: x1 - 8, y: y(v) + 4, "text-anchor": "end" }); t.textContent = fmt(v); svg.appendChild(t);
  });
}
function xLabels(svg, labels, xs, yy) {
  const every = xs.length > 1 && xs[1] - xs[0] < 22 ? 2 : 1;   // thin out when crowded
  labels.forEach((l, i) => {
    if (i % every && i !== labels.length - 1) return;
    const t = svgEl("text", { x: xs[i], y: yy, "text-anchor": "middle" }); t.textContent = l; svg.appendChild(t);
  });
}
/* draw at the card's real width (up to 900), so chart text stays readable on phones */
function chartWidth(host) { return Math.round(Math.min(900, Math.max(300, host.clientWidth || 900))); }
function ticksBetween(lo, hi, count) {
  const step = niceStep((hi - lo) / count || 1);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.01; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/* Championship points per round: the champion and three rivals, with a crosshair */
function drawTitleRace(host, series, rounds, clinchRound, names) {
  const W = chartWidth(host), H = W < 600 ? 240 : 320, m = { t: 20, r: 36, b: 28, l: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const val = (s, r) => s.pts.get(r) ?? null;
  const ticks = ticksBetween(0, Math.max(10, ...series.flatMap((s) => rounds.map((r) => val(s, r) || 0))), 4);
  const top = ticks[ticks.length - 1];
  const xs = rounds.map((r, i) => m.l + (rounds.length === 1 ? iw / 2 : (i / (rounds.length - 1)) * iw));
  const y = (v) => m.t + ih - (v / top) * ih;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Championship points after each round" });
  yAxis(svg, ticks, y, m.l, W - m.r);
  xLabels(svg, rounds, xs, H - 8);
  const ci = rounds.indexOf(clinchRound);
  if (ci >= 0) {
    // the bottom of the chart is empty by the time a title is decided, so the label goes there
    svg.appendChild(svgEl("line", { x1: xs[ci], x2: xs[ci], y1: m.t, y2: m.t + ih, stroke: "var(--border-2)", "stroke-width": 1 }));
    const t = svgEl("text", { x: xs[ci] - 6, y: m.t + ih - 8, "text-anchor": "end" }); t.textContent = "Title clinched"; svg.appendChild(t);
  }
  [...series].reverse().forEach((s) => {
    const pts = rounds.map((r, i) => (val(s, r) == null ? null : `${xs[i]},${y(val(s, r))}`)).filter(Boolean).join(" ");
    svg.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  });
  const c = series[0], li = rounds.length - 1, cv = val(c, rounds[li]);
  if (cv != null) {
    svg.appendChild(svgEl("circle", { cx: xs[li], cy: y(cv), r: 4, fill: c.color, stroke: "var(--bg)", "stroke-width": 2 }));
    const t = svgEl("text", { x: xs[li] + 9, y: y(cv) + 4, class: "end-label" }); t.textContent = cv; svg.appendChild(t);
  }
  const cross = svgEl("line", { y1: m.t, y2: m.t + ih, stroke: "var(--border-2)", "stroke-width": 1, opacity: 0 });
  svg.appendChild(cross);
  const overlay = svgEl("rect", { x: m.l - 10, y: m.t, width: iw + 20, height: ih, fill: "transparent" });
  overlay.addEventListener("mousemove", (e) => {
    const i = nearestIndex(e, svg, W, xs), r = rounds[i];
    cross.setAttribute("x1", xs[i]); cross.setAttribute("x2", xs[i]); cross.setAttribute("opacity", 1);
    const lines = series.map((s) => ({ s, v: val(s, r) })).filter((o) => o.v != null).sort((a, b) => b.v - a.v);
    showTip(`<b>Round ${r} · ${esc(names.get(r) || "")}</b><br>` +
      lines.map((o) => `<span class="key" style="background:${o.s.color}"></span>${esc(o.s.code)} <span class="tv">${o.v}</span>`).join("<br>"), e);
  });
  overlay.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
  svg.appendChild(overlay);
  host.innerHTML = ""; host.appendChild(svg);
}

/* Lead over P2 (columns) against the points a rival could still score (line) */
function drawClinchChart(host, rows, clinchRound) {
  const W = chartWidth(host), H = W < 600 ? 220 : 280, m = { t: 22, r: 16, b: 28, l: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const band = iw / rows.length, bw = Math.min(24, band * 0.6);
  const ticks = ticksBetween(Math.min(0, ...rows.map((r) => r.lead ?? 0)), Math.max(10, ...rows.map((r) => Math.max(r.lead ?? 0, r.avail))), 5);
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const y = (v) => m.t + ((hi - v) / (hi - lo)) * ih;
  const xs = rows.map((r, i) => m.l + band * (i + 0.5));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Championship lead against the points still available" });
  yAxis(svg, ticks, y, m.l, W - m.r);
  svg.appendChild(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: "var(--border-2)", "stroke-width": 1 }));
  xLabels(svg, rows.map((r) => r.round), xs, H - 8);
  rows.forEach((r, i) => {
    if (r.lead == null) return;
    svg.appendChild(svgEl("path", { d: colPath(xs[i] - bw / 2, bw, y(0), y(r.lead)), fill: r.lead > 0 ? "var(--s1)" : "var(--faint)" }));
  });
  svg.appendChild(svgEl("polyline", { points: rows.map((r, i) => `${xs[i]},${y(r.avail)}`).join(" "), fill: "none", stroke: "var(--s2)", "stroke-width": 2, "stroke-linejoin": "round" }));
  const ci = rows.findIndex((r) => r.round === clinchRound);
  if (ci >= 0) {
    const t = svgEl("text", { x: xs[ci], y: y(Math.max(rows[ci].lead, rows[ci].avail)) - 8, "text-anchor": "middle", class: "end-label" });
    t.textContent = "Clinched"; svg.appendChild(t);
  }
  rows.forEach((r, i) => {
    const hit = svgEl("rect", { x: xs[i] - band / 2, y: m.t, width: band, height: ih, fill: "transparent" });
    const lead = r.lead == null ? "—" : r.lead > 0 ? `+${r.lead}` : r.lead;
    const html = `<b>Round ${r.round} · ${esc(r.name)}</b><br>Lead <span class="tv">${lead}</span><br>Still available <span class="tv">${r.avail}</span>`;
    hit.addEventListener("mousemove", (e) => showTip(html, e));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });
  host.innerHTML = ""; host.appendChild(svg);
}

/* Dumbbells per race: grid slot (ring) to finishing position (dot), P1 at the top */
function drawGridFinish(host, rows) {
  const W = chartWidth(host), H = W < 600 ? 240 : 300, m = { t: 12, r: 16, b: 28, l: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const band = iw / rows.length;
  const maxP = Math.max(20, ...rows.map((r) => Math.max(r.grid, r.finish)));
  const y = (p) => m.t + ((p - 1) / (maxP - 1)) * ih;
  const xs = rows.map((r, i) => m.l + band * (i + 0.5));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Grid position and finishing position in every race" });
  yAxis(svg, [1, 5, 10, 15, 20].filter((p) => p <= maxP), y, m.l, W - m.r, (p) => "P" + p);
  xLabels(svg, rows.map((r) => r.round), xs, H - 8);
  rows.forEach((r, i) => {
    const x = xs[i];
    if (r.grid !== r.finish) svg.appendChild(svgEl("line", { x1: x, x2: x, y1: y(r.grid), y2: y(r.finish), stroke: "var(--border-2)", "stroke-width": 2, "stroke-linecap": "round" }));
    svg.appendChild(svgEl("circle", { cx: x, cy: y(r.grid), r: 4, fill: "var(--bg)", stroke: "var(--muted)", "stroke-width": 2 }));
    svg.appendChild(svgEl("circle", { cx: x, cy: y(r.finish), r: 5, fill: r.dnf ? "var(--faint)" : "var(--s1)", stroke: "var(--bg)", "stroke-width": 2 }));
    const hit = svgEl("rect", { x: x - band / 2, y: m.t - 6, width: band, height: ih + 12, fill: "transparent" });
    const gained = r.dnf ? "" : r.grid - r.finish > 0 ? ` (+${r.grid - r.finish})` : r.grid - r.finish < 0 ? ` (${r.grid - r.finish})` : "";
    const html = `<b>Round ${r.round} · ${esc(r.name)}</b><br>Grid <span class="tv">${esc(r.gridText)}</span> → ${r.dnf ? esc(r.status) : `<span class="tv">P${r.finish}</span>${gained}`}`;
    hit.addEventListener("mousemove", (e) => showTip(html, e));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });
  host.innerHTML = ""; host.appendChild(svg);
}

/* Qualifying gap to pole per round, with pole positions as dots on the baseline */
function drawPoleGap(host, rows) {
  const W = chartWidth(host), H = W < 600 ? 200 : 240, m = { t: 12, r: 16, b: 28, l: 48 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const band = iw / rows.length, bw = Math.min(24, band * 0.6);
  const ticks = ticksBetween(0, Math.max(0.2, ...rows.map((r) => r.qGap ?? 0)), 4);
  const top = ticks[ticks.length - 1];
  const y = (v) => m.t + ih - (v / top) * ih;
  const xs = rows.map((r, i) => m.l + band * (i + 0.5));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Qualifying gap to pole in every round" });
  yAxis(svg, ticks, y, m.l, W - m.r, (v) => v.toFixed(top < 1 ? 2 : 1) + "s");
  svg.appendChild(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: "var(--border-2)", "stroke-width": 1 }));
  xLabels(svg, rows.map((r) => r.round), xs, H - 8);
  rows.forEach((r, i) => {
    if (r.qGap == null) return;
    if (r.pole) svg.appendChild(svgEl("circle", { cx: xs[i], cy: y(0), r: 4, fill: "var(--s1)", stroke: "var(--bg)", "stroke-width": 2 }));
    else svg.appendChild(svgEl("path", { d: colPath(xs[i] - bw / 2, bw, y(0), y(r.qGap)), fill: "var(--s1)" }));
    const hit = svgEl("rect", { x: xs[i] - band / 2, y: m.t, width: band, height: ih, fill: "transparent" });
    const html = `<b>Round ${r.round} · ${esc(r.name)}</b><br>Qualified <span class="tv">P${r.quali}</span>${r.pole ? " (pole)" : ` · <span class="tv">+${r.qGap.toFixed(3)}s</span> to pole`}`;
    hit.addEventListener("mousemove", (e) => showTip(html, e));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });
  host.innerHTML = ""; host.appendChild(svg);
}

/* ============================================================
   NEXT-SEASON PREDICTION
   Computed offline by ml/predict_next_season.py from the data warehouse
   (Plackett–Luce strengths → carry-over regression → 10,000 simulated
   seasons, plus a walk-forward backtest) and published as
   predictions/next-season.json. This page presents and explains it.
   ============================================================ */
let predictionCache = null;
async function getPrediction() {
  if (predictionCache) return predictionCache;
  const r = await fetch("predictions/next-season.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(r.status === 404 ? "The prediction file hasn't been generated yet." : `HTTP ${r.status} loading the prediction`);
  predictionCache = await r.json();
  return predictionCache;
}
function pctLabel(p) {
  const v = p * 100;
  if (v >= 9.95) return v.toFixed(0) + "%";
  if (v >= 0.95) return v.toFixed(1) + "%";
  return v > 0 ? "<1%" : "—";
}
const pctInt = (p) => Math.round(p * 100) + "%";
function num2(x) { return (x < 0 ? "−" : "") + Math.abs(x).toFixed(2); }
function signed2(x) { return (x < 0 ? "−" : "+") + Math.abs(x).toFixed(2); }
function lastName(name) { return name.split(" ").slice(-1)[0]; }
function shortTeam(t) { return t.replace(/ F1 Team$/, ""); }
const METHOD_LABELS = { repeat: "Last year repeats", noSurprise: "Model, no winter surprise", model: "Model (used here)" };

async function renderPrediction() {
  showLoader("Loading the prediction…");
  let P;
  try { P = await getPrediction(); }
  catch (err) {
    view.innerHTML = `
      <div class="errbox">
        <h2>Prediction not available</h2>
        <p>${esc(err.message)}</p>
        <p>It's computed offline from the data warehouse. In the project folder run
          <code>python warehouse/build_warehouse.py</code>, then <code>python ml/predict_next_season.py</code>, and refresh.</p>
      </div>`;
    return;
  }
  try { paintPrediction(P); } catch (err) { showError(err); }
}

function paintPrediction(P) {
  const { drivers: D, constructors: C, model: M, backtest: B, settings: S, dataThrough: T } = P;
  const co = M.coefficients, sm = B.summary;
  const fav = [...D].sort((a, b) => b.title - a.title)[0];
  const favTeam = [...C].sort((a, b) => b.title - a.title)[0];
  const provisional = T.round < T.roundsInSeason;
  const generated = new Date(P.generatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const sims = S.simulations.toLocaleString();
  const btFirst = B.seasons[0].season, btLast = B.seasons[B.seasons.length - 1].season;
  const trap = P.retirementTrap.slice(0, 8);
  const trapWorst = [...trap].sort((a, b) => (b.strength - b.strengthAllStarters) - (a.strength - a.strengthAllStarters))[0];
  const changes = Object.keys(S.lineupChanges || {}).length;

  const status = provisional
    ? `<span class="status-pill open">Provisional: uses ${T.season} up to round ${T.round} of ${T.roundsInSeason} (${esc(T.race.replace(/ Grand Prix$/, ""))}) and updates as the season finishes</span>`
    : `<span class="status-pill clinched">Based on the complete ${T.season} season</span>`;

  view.innerHTML = `
    <div class="page-head">
      <h1>${P.season} championship prediction</h1>
      <p class="sub">Who is most likely to be champion in ${P.season}, estimated before a ${P.season} car has turned a wheel:
        ${sims} simulated seasons from a model trained on every Grand Prix since ${M.firstSeason}.</p>
      <p class="sub">${status}</p>
    </div>

    <nav class="toc" aria-label="On this page">
      <button type="button" data-jump="pr-forecast">Forecast</button>
      <button type="button" data-jump="pr-method">How it works</button>
      <button type="button" data-jump="pr-calc">The calculation</button>
      <button type="button" data-jump="pr-backtest">Track record</button>
      <button type="button" data-jump="pr-limits">Limitations</button>
    </nav>

    <div class="kpi-row">
      <div class="kpi"><div class="k">Favourite</div><div class="v">${esc(fav.code)} · ${pctLabel(fav.title)}</div><div class="meta2">${esc(fav.name)}</div></div>
      <div class="kpi"><div class="k">Constructors' favourite</div><div class="v">${esc(shortTeam(favTeam.name))} · ${pctLabel(favTeam.title)}</div><div class="meta2">title chance</div></div>
      <div class="kpi"><div class="k">Simulated seasons</div><div class="v">${sims}</div><div class="meta2">× ${S.races} races each</div></div>
      <div class="kpi"><div class="k">Track record</div><div class="v">${pctInt(sm.model.coverage)}</div><div class="meta2">inside the 80% range, ${btFirst}–${String(btLast).slice(2)}</div></div>
    </div>

    <h2 class="section-title" id="pr-forecast">The forecast</h2>
    <div class="dash-grid" style="margin-top:0">
      <div class="chart-card">
        <h3>Drivers' title chance</h3>
        <p class="csub">Share of the ${sims} simulated ${P.season} seasons that each driver finishes on top.</p>
        <div class="bar-list">${probBars(D.filter((d) => d.title >= 0.005).sort((a, b) => b.title - a.title), (d) => `${d.code} · ${lastName(d.name)}`, (d) => d.team)}</div>
      </div>
      <div class="chart-card">
        <h3>Constructors' title chance</h3>
        <p class="csub">Both cars' points added together, in the same simulated seasons.</p>
        <div class="bar-list">${probBars(C.filter((t) => t.title >= 0.005), (t) => shortTeam(t.name), (t) => t.name)}</div>
      </div>

      <div class="chart-card span-2">
        <h3>Predicted ${P.season} points</h3>
        <p class="csub">Dot: expected points. Thick bar: the middle half of simulated seasons. Thin bar: 80% of them. The width is the honest size of not knowing yet how good each car will be.</p>
        <div id="prRange"></div>
      </div>

      <div class="span-2">
        <div class="table-wrap">
          <table class="grid">
            <thead><tr>
              <th>Pred.</th><th>Driver</th><th>Team</th>
              <th class="num">Title</th><th class="num">Top 3</th><th class="num">Exp. pts</th><th class="num">Likely range (80%)</th>
            </tr></thead>
            <tbody>${D.map((d, i) => `
              <tr style="--team:${teamColor(d.team)}">
                <td class="pos-cell ${["", "p1", "p2", "p3"][i + 1] || ""}">${i + 1}</td>
                <td><span class="driver-cell"><a href="#/driver/${encodeURIComponent(d.id)}">${esc(d.name)}</a>${d.inputs.rookie ? ` <span class="code">rookie</span>` : ""}</span></td>
                <td><span class="team-tag"><i class="bar"></i>${esc(shortTeam(d.team))}</span></td>
                <td class="num prob-pct">${pctLabel(d.title)}</td>
                <td class="num">${pctLabel(d.top3)}</td>
                <td class="num"><b>${Math.round(d.mean)}</b></td>
                <td class="num"><span class="proj-range">${d.p10}–${d.p90}</span></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="chart-card span-2">
        <h3>Final championship position</h3>
        <p class="csub">How often each driver finishes the ${P.season} championship in each place, for the ten highest expected scorers.</p>
        <div class="table-wrap">${positionHeat(D, 10)}</div>
      </div>
    </div>

    <h2 class="section-title" id="pr-method">How the prediction works</h2>
    <p class="prose">The model answers one question: <b>how much of what happened in ${T.season} will still be true in ${P.season}?</b>
      Steps 1–3 are the machine learning: every number is learned from past results, none is set by hand.
      Step 4 turns what was learned into probabilities.</p>
    <div class="step-grid">
      <div class="step">
        <span class="step__n">1</span><h3>Measure every driver's pace</h3>
        <p>A <b>Plackett–Luce</b> model reads each race result as a series of picks: the winner is picked from the whole field,
          P2 from the drivers left, and so on. Every driver gets a <b>strength</b>, chosen so the real finishing orders are
          as likely as possible (maximum likelihood). A driver 1.0 stronger is <b>2.7×</b> as likely to be picked first.
          Fitted for each season on ${M.races} races, ${M.firstSeason}–${T.season}.</p>
        <span class="step__tag learned">Learned from data</span>
      </div>
      <div class="step">
        <span class="step__n">2</span><h3>Learn what carries over</h3>
        <p>A regression on <b>${M.trainingPairs} driver-seasons</b> (${M.trainingSeasons[0]}–${M.trainingSeasons[1]}) links each
          driver's strength to the season before: the <b>car</b> (the team's strength last year) and the <b>driver</b>
          (their edge over their own teammate). It learned that <b>${pctInt(co.team_prev)}</b> of a car's advantage survives
          a winter, <b>${pctInt(co.driver_edge)}</b> of a driver's edge does, and rookies start <b>${num2(Math.abs(co.rookie))}</b> behind.</p>
        <span class="step__tag learned">Learned from data</span>
      </div>
      <div class="step">
        <span class="step__n">3</span><h3>Measure the winter surprise</h3>
        <p>How far teams and drivers landed from that prediction in the past: typically <b>±${M.sigmaTeam.toFixed(2)}</b> for a whole car
          and <b>±${M.sigmaDriver.toFixed(2)}</b> for a driver, so the car is the big unknown. Noise in the strengths themselves
          (±${M.measurementNoise.toFixed(2)}, found by fitting each season twice, on its odd and its even races) is taken out,
          so luck isn't counted twice.</p>
        <span class="step__tag learned">Learned from data</span>
      </div>
      <div class="step">
        <span class="step__n">4</span><h3>Simulate ${P.season}, ${sims} times</h3>
        <p>Each simulated season draws a winter surprise for every car and driver, then runs <b>${S.races} races</b>. Each driver
          retires with probability <b>${pctInt(S.dnfRate)}</b> (the recent average); the finishers are ordered by strength plus
          random race-day luck, and score ${S.points.join("-")}. A title chance is the share of seasons a driver ends on top.</p>
        <span class="step__tag sim">Simulation</span>
      </div>
    </div>

    <div class="kpi-row" style="margin-top:14px">
      <div class="kpi"><div class="k">Car carry-over</div><div class="v">${pctInt(co.team_prev)}</div><div class="meta2">of last year's advantage</div></div>
      <div class="kpi"><div class="k">Driver carry-over</div><div class="v">${pctInt(co.driver_edge)}</div><div class="meta2">of the edge over a teammate</div></div>
      <div class="kpi"><div class="k">Rookie start</div><div class="v">${num2(co.rookie)}</div><div class="meta2">strength vs the car alone</div></div>
      <div class="kpi"><div class="k">Winter surprise</div><div class="v">±${M.sigmaTeam.toFixed(2)}</div><div class="meta2">car · ±${M.sigmaDriver.toFixed(2)} driver</div></div>
    </div>

    <div class="dash-grid">
      <div class="chart-card">
        <h3>How much of a car's advantage survives a winter?</h3>
        <p class="csub">Each dot is one team in one season, ${M.trainingSeasons[0]}–${M.trainingSeasons[1]}. On the dashed line everything would
          carry over. The red line is what the model learned.</p>
        <div class="chart" id="prCarry"></div>
        <div class="chart-legend">
          <span><i class="forecast" style="border-top-color:var(--faint)"></i>Everything carries over</span>
          <span><i style="border-top-color:var(--accent)"></i>Learned: ${pctInt(co.team_prev)} carries over</span>
        </div>
      </div>
      <div class="chart-card">
        <h3>Why retirements are left out of step 1</h3>
        <p class="csub">Counting a retirement as "finished last" tells the model the driver lost to the entire field.
          ${trapWorst ? `${esc(trapWorst.name)} (${trapWorst.dnfs} retirements) would rate ${num2(trapWorst.strengthAllStarters)} instead of ${num2(trapWorst.strength)}.` : ""}
          So pace is learned from finishers only, and retirements are simulated separately in step 4.</p>
        <div class="table-wrap">
          <table class="grid compact">
            <thead><tr><th>${T.season} driver</th><th class="num">Pts</th><th class="num">DNFs</th><th class="num">DNF = last</th><th class="num">Finishers only</th></tr></thead>
            <tbody>${trap.map((t) => `
              <tr style="--team:${teamColor(t.team)}">
                <td><span class="team-tag"><i class="bar"></i>${esc(t.name)}</span></td>
                <td class="num">${t.points}</td><td class="num">${t.dnfs}</td>
                <td class="num muted-num">${num2(t.strengthAllStarters)}</td><td class="num"><b>${num2(t.strength)}</b></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <h2 class="section-title" id="pr-calc">The calculation, driver by driver</h2>
    <p class="prose">Every driver's predicted ${P.season} strength comes from the same three inputs and the learned weights:</p>
    <div class="formula">strength<sub>${P.season}</sub> = ${num2(co.intercept)} + ${num2(co.team_prev)} × car<sub>${T.season}</sub> + ${num2(co.driver_edge)} × driver edge<sub>${T.season}</sub> ${co.rookie < 0 ? "−" : "+"} ${num2(Math.abs(co.rookie))} × rookie</div>
    <div class="calc-card">
      <div class="calc-card__head">
        <span class="scenario-bar__title">Worked example</span>
        <div class="round-select-wrap">
          <select class="round-select" id="calcDriver" aria-label="Driver for the worked example">
            ${D.map((d) => `<option value="${esc(d.id)}" ${d.id === fav.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
          </select>${CHEVRON}
        </div>
      </div>
      <div id="calcBody"></div>
    </div>
    <div class="table-wrap" style="margin-top:14px">
      <table class="grid">
        <thead><tr>
          <th>Driver</th><th>${P.season} team</th>
          <th class="num" title="Team's ${T.season} strength (the car)">Car ${T.season}</th>
          <th class="num" title="Edge over their ${T.season} teammate">Driver edge</th>
          <th class="num">Rookie</th><th class="num">Predicted strength</th><th class="num">Title</th>
        </tr></thead>
        <tbody>${[...D].sort((a, b) => b.inputs.strength - a.inputs.strength).map((d) => `
          <tr style="--team:${teamColor(d.team)}">
            <td><span class="driver-cell"><a href="#/driver/${encodeURIComponent(d.id)}">${esc(d.name)}</a></span></td>
            <td><span class="team-tag"><i class="bar"></i>${esc(shortTeam(d.team))}</span></td>
            <td class="num">${num2(d.inputs.teamPrev)}${d.inputs.newTeam ? "*" : ""}</td>
            <td class="num">${num2(d.inputs.driverEdge)}</td>
            <td class="num">${d.inputs.rookie ? "yes" : "–"}</td>
            <td class="num"><b>${num2(d.inputs.strength)}</b></td>
            <td class="num prob-pct">${pctLabel(d.title)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="table-note">Strengths are on the Plackett–Luce scale, centred on the average driver. "Car" is the team's ${T.season} strength
      (both drivers, weighted by races). "Driver edge" is how much stronger the driver was than their own ${T.season} team.
      ${D.some((d) => d.inputs.newTeam) ? "* A brand-new team is placed level with the slowest existing team." : ""}</p>

    <h2 class="section-title" id="pr-backtest">Track record: testing on ${btFirst}–${btLast}</h2>
    <p class="prose">Before trusting it with ${P.season}, the whole method was replayed on every season from ${btFirst} to ${btLast},
      each time learning only from the seasons before (a <b>walk-forward backtest</b>). It's compared with the simplest guess,
      <b>"last year repeats"</b>, and with the same model minus its winter surprise.</p>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr>
          <th>Method</th><th class="num">P(actual champion)</th><th class="num">Champion log score</th>
          <th class="num">80% range coverage</th><th class="num">Order correlation</th>
        </tr></thead>
        <tbody>${["repeat", "noSurprise", "model"].map((k) => `
          <tr${k === "model" ? ' class="is-used"' : ""}>
            <td>${k === "model" ? `<b>${METHOD_LABELS[k]}</b>` : METHOD_LABELS[k]}</td>
            <td class="num">${pctInt(sm[k].p)}</td>
            <td class="num">${num2(sm[k].logScore)}</td>
            <td class="num"><b>${pctInt(sm[k].coverage)}</b></td>
            <td class="num">${sm[k].orderCorr.toFixed(2)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="table-note"><b>P(actual champion)</b>: the average probability given in advance to the driver who went on to win.
      <b>Log score</b>: the log of that probability (closer to 0 is better; it punishes confident misses).
      <b>Coverage</b>: the share of drivers whose real points landed inside their predicted 80% range, which should be close to 80%.
      <b>Order correlation</b>: how well expected points ranked the whole field (1 = perfect).</p>
    <p class="prose">The two confident versions give the eventual champion a higher probability, because ${btFirst}–${btLast} was mostly won
      by one dominant car at a time. But only <b>${pctInt(sm.repeat.coverage)}</b> of drivers finished inside their predicted 80% range:
      those forecasts were overconfident. The full model's ranges held <b>${pctInt(sm.model.coverage)}</b>, close to the 80% target,
      so it's the version used for ${P.season}. All three rank the field equally well.</p>
    <div class="table-wrap">
      <table class="grid compact">
        <thead><tr><th>Season</th><th>Champion</th>${["repeat", "noSurprise", "model"].map((k) => `<th class="num">${METHOD_LABELS[k].replace(" (used here)", "")}</th>`).join("")}</tr></thead>
        <tbody>${B.seasons.map((s) => `
          <tr>
            <td class="mono">${s.season}</td><td>${esc(s.champion)}</td>
            ${["repeat", "noSurprise", "model"].map((k) => `<td class="num" title="Favourite: ${esc(s[k].favourite)}">${pctLabel(s[k].p)}</td>`).join("")}
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="table-note">The title chance each method gave the eventual champion before the season. Hover a cell for that method's favourite.</p>

    <h2 class="section-title" id="pr-limits">Limitations</h2>
    <ul class="limits">
      ${provisional ? `<li><b>${T.season} isn't finished.</b> The prediction uses ${T.round} of ${T.roundsInSeason} rounds and is regenerated as results come in.</li>` : ""}
      <li><b>Line-ups:</b> every driver is assumed to stay with their team from the latest race${changes ? `, apart from ${changes} change${changes === 1 ? "" : "s"} entered by hand` : ""}. Announced moves aren't otherwise included.</li>
      <li><b>Calendar:</b> ${S.races} races are assumed. Sprint races and their points aren't modelled.</li>
      <li><b>Reliability:</b> every car gets the same ${pctInt(S.dnfRate)} chance of retiring from each race.</li>
      <li><b>Development:</b> after the winter surprise, a car's strength stays fixed for the whole simulated season.</li>
      <li><b>Rules:</b> the model knows nothing about regulation changes. In a second year of the same rules the field usually closes up, which it can't anticipate.</li>
      ${M.missingSeasons.length ? `<li><b>Missing data:</b> ${M.missingSeasons.join(", ")} results aren't in the training data.</li>` : ""}
      <li><b>A probability, not a pick:</b> even the favourite, at ${pctLabel(fav.title)}, fails to win the title in most simulated seasons.</li>
    </ul>

    <p class="pipeline">
      Generated ${generated} by ml/predict_next_season.py from the Jolpica F1 API and the Ergast archive:
      a Plackett–Luce model (NumPy/SciPy) and ${sims} Monte Carlo seasons.
    </p>
  `;

  $("#prRange").innerHTML = rangeList(D);
  view.querySelectorAll(".range-row[data-i]").forEach((row) => {
    const d = D[Number(row.dataset.i)];
    const html = `<b>${esc(d.name)}</b><br>Expected <span class="tv">${Math.round(d.mean)} pts</span><br>
      Middle half <span class="tv">${d.p25}–${d.p75}</span> · 80% <span class="tv">${d.p10}–${d.p90}</span><br>Title <span class="tv">${pctLabel(d.title)}</span>`;
    row.addEventListener("mousemove", (e) => showTip(html, e));
    row.addEventListener("mouseleave", hideTip);
  });
  drawCarryover($("#prCarry"), P.carryover, co);

  const calcSel = $("#calcDriver");
  const paintCalc = () => { $("#calcBody").innerHTML = calcHTML(D.find((d) => d.id === calcSel.value) || fav, P); };
  calcSel.addEventListener("change", paintCalc);
  paintCalc();

  wireJumpLinks();
}

/* in-page contents buttons: <button data-jump="section-id"> */
function wireJumpLinks() {
  const smooth = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  view.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () =>
    document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: smooth, block: "start" })));
}

/* horizontal probability bars, scaled to the largest value */
function probBars(items, label, team) {
  const max = Math.max(...items.map((d) => d.title), 1e-9);
  return items.map((d) => `
    <div class="bar-row">
      <span class="bar-row__label">${esc(label(d))}</span>
      <span class="bar-row__track"><span class="bar-row__fill" style="width:${Math.max(1, (d.title / max) * 100)}%;--bc:${teamColor(team(d))}"></span></span>
      <span class="bar-row__val prob-pct">${pctLabel(d.title)}</span>
    </div>`).join("");
}

/* points range per driver: 80% bar, middle-half bar and the expected value */
function rangeList(drivers) {
  const maxV = Math.max(...drivers.map((d) => d.p90), 10);
  const step = niceStep(maxV / 5), top = Math.ceil(maxV / step) * step;
  const x = (v) => (v / top) * 100;
  let ticks = "";
  for (let v = 0; v <= top + 0.1; v += step) ticks += `<span style="left:${x(v)}%">${v}</span>`;
  return `<div class="range-list">${drivers.map((d, i) => `
    <div class="range-row" data-i="${i}" style="--team:${teamColor(d.team)}">
      <span class="bar-row__label">${esc(d.code)} · ${esc(lastName(d.name))}</span>
      <span class="range-track">
        <i class="range-80" style="left:${x(d.p10)}%;width:${x(d.p90) - x(d.p10)}%"></i>
        <i class="range-50" style="left:${x(d.p25)}%;width:${x(d.p75) - x(d.p25)}%"></i>
        <i class="range-dot" style="left:${x(d.mean)}%"></i>
      </span>
      <span class="bar-row__val">${Math.round(d.mean)}</span>
    </div>`).join("")}
    <div class="range-row range-axis" aria-hidden="true"><span></span><span class="range-ticks">${ticks}</span><span></span></div>
  </div>`;
}

/* driver × final position probabilities, shaded in team colour */
function positionHeat(drivers, n) {
  const top = drivers.slice(0, n);
  const max = Math.max(...top.flatMap((d) => d.positions.slice(0, n)), 1e-9);
  return `<table class="grid heat">
    <thead><tr><th>Driver</th>${Array.from({ length: n }, (_, i) => `<th class="num">P${i + 1}</th>`).join("")}</tr></thead>
    <tbody>${top.map((d) => `
      <tr style="--team:${teamColor(d.team)}">
        <td><span class="team-tag"><i class="bar"></i>${esc(d.name)}</span></td>
        ${d.positions.slice(0, n).map((p) => `<td class="hc" style="background:color-mix(in srgb, var(--team) ${Math.round((p / max) * 60)}%, transparent)">${p >= 0.005 ? Math.round(p * 100) + "%" : ""}</td>`).join("")}
      </tr>`).join("")}
    </tbody>
  </table>`;
}

/* the worked example for one driver */
function calcHTML(d, P) {
  const co = P.model.coefficients, i = d.inputs, T = P.dataThrough;
  const parts = [
    ["", "", num2(co.intercept), "baseline"],
    ["+", `${num2(co.team_prev)} × ${num2(i.teamPrev)}`, signed2(co.team_prev * i.teamPrev),
      `car: ${esc(shortTeam(d.team))}'s ${T.season} strength${i.newTeam ? " (new team, so level with the slowest)" : ""}`],
    ["+", `${num2(co.driver_edge)} × ${num2(i.driverEdge)}`, signed2(co.driver_edge * i.driverEdge),
      i.rookie ? "driver: no previous season, so 0" : `driver: edge over their ${T.season} teammate`],
    ["+", `${num2(co.rookie)} × ${i.rookie ? 1 : 0}`, signed2(co.rookie * (i.rookie ? 1 : 0)), `rookie: ${i.rookie ? "yes" : "no"}`],
  ];
  return `
    <table class="calc"><tbody>
      ${parts.map(([op, expr, val, what]) => `<tr><td class="op">${op}</td><td class="expr">${expr}</td><td class="val">${val}</td><td class="what">${what}</td></tr>`).join("")}
      <tr class="total"><td class="op">=</td><td class="expr"></td><td class="val">${num2(i.strength)}</td><td class="what">predicted ${P.season} strength</td></tr>
    </tbody></table>
    <p class="calc-after">Then, in each of the ${P.settings.simulations.toLocaleString()} simulated seasons, the car moves by a random amount
      (typically ±${P.model.sigmaTeam.toFixed(2)}) and the driver by ±${P.model.sigmaDriver.toFixed(2)} before ${P.settings.races} races are run.
      Result for ${esc(d.name)}: <b>title in ${pctLabel(d.title)}</b> of seasons, <b>${Math.round(d.mean)} points</b> expected
      (80% range ${d.p10}–${d.p90}).</p>`;
}

/* scatter: team strength last season vs this season, with the learned line */
function drawCarryover(host, pts, co) {
  const W = 460, H = 300, m = { t: 12, r: 14, b: 34, l: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const all = pts.flatMap((p) => [p.lastYear, p.thisYear]);
  const lo = Math.floor(Math.min(...all)), hi = Math.ceil(Math.max(...all));
  const x = (v) => m.l + ((v - lo) / (hi - lo)) * iw;
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Team strength last season against this season" });

  for (let v = lo; v <= hi; v++) {
    svg.appendChild(svgEl("line", { class: "grid-line", x1: m.l, y1: y(v), x2: W - m.r, y2: y(v) }));
    svg.appendChild(svgEl("line", { class: "grid-line", x1: x(v), y1: m.t, x2: x(v), y2: m.t + ih }));
    const ty = svgEl("text", { x: m.l - 6, y: y(v) + 3, "text-anchor": "end" }); ty.textContent = v; svg.appendChild(ty);
    const tx = svgEl("text", { x: x(v), y: m.t + ih + 14, "text-anchor": "middle" }); tx.textContent = v; svg.appendChild(tx);
  }
  const xl = svgEl("text", { x: m.l + iw / 2, y: H - 4, "text-anchor": "middle" }); xl.textContent = "team strength last season"; svg.appendChild(xl);
  const yl = svgEl("text", { x: 0, y: 0, "text-anchor": "middle", transform: `translate(9 ${m.t + ih / 2}) rotate(-90)` });
  yl.textContent = "this season"; svg.appendChild(yl);

  svg.appendChild(svgEl("line", { x1: x(lo), y1: y(lo), x2: x(hi), y2: y(hi), stroke: "var(--faint)", "stroke-width": 1.2, "stroke-dasharray": "5 4" }));
  const f = (v) => co.intercept + co.team_prev * v;
  pts.forEach((p) => {
    svg.appendChild(svgEl("circle", { cx: x(p.lastYear), cy: y(p.thisYear), r: 3.6, fill: "var(--s1)", opacity: .7 }));
  });
  svg.appendChild(svgEl("line", { x1: x(lo), y1: y(f(lo)), x2: x(hi), y2: y(f(hi)), stroke: "var(--accent)", "stroke-width": 2.2, "stroke-linecap": "round" }));
  pts.forEach((p) => {
    const hit = svgEl("circle", { cx: x(p.lastYear), cy: y(p.thisYear), r: 8, fill: "transparent" });
    const html = `<b>${esc(shortTeam(p.team))} ${p.season}</b><br>Last season <span class="tv">${num2(p.lastYear)}</span> → <span class="tv">${num2(p.thisYear)}</span>`;
    hit.addEventListener("mousemove", (e) => showTip(html, e));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);
  });
  host.appendChild(svg);
}

/* ============================================================
   Sidebar: driver dropdown
   ============================================================ */
async function loadSidebarDrivers() {
  const sel = $("#driverSelect");
  try {
    const data = await getJSON("current/driverstandings.json");
    const list = data.MRData.StandingsTable.StandingsLists[0];
    const season = data.MRData.StandingsTable.season;
    $("#brandSeason").textContent = season;
    if (list && championVisible(season)) {
      $("#champLabel").textContent = `${season} Champion`;
      $("#champLink").hidden = false;
    }
    if (!list) { sel.innerHTML = `<option value="">No drivers yet</option>`; return; }
    sel.innerHTML = `<option value="">Select a driver…</option>` +
      list.DriverStandings.map((s) =>
        `<option value="${esc(s.Driver.driverId)}">${esc(s.position)}. ${esc(fullName(s.Driver))}</option>`
      ).join("");
    sel.addEventListener("change", () => {
      if (sel.value) { location.hash = `#/driver/${encodeURIComponent(sel.value)}`; closeSidebar(); }
    });
    setActiveDriver(currentDriverId());
  } catch (err) {
    sel.innerHTML = `<option value="">Drivers unavailable</option>`;
  }
}
function setActiveDriver(id) {
  const sel = $("#driverSelect");
  if (sel) sel.value = id || "";
}
function currentDriverId() {
  const m = location.hash.match(/^#\/driver\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ============================================================
   Router
   ============================================================ */
function setActiveNav(route) {
  document.querySelectorAll(".nav__link").forEach((a) => a.classList.toggle("is-active", a.dataset.route === route));
}
function router() {
  const hash = location.hash || "#/latest";
  view.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  let m;
  if ((m = hash.match(/^#\/dashboard(?:\/(\d+))?$/))) { setActiveNav("dashboard"); setActiveDriver(null); renderDashboard(m[1] ? Number(m[1]) : null); }
  else if ((m = hash.match(/^#\/race\/(.+)$/))) { setActiveNav("season"); setActiveDriver(null); renderRace(decodeURIComponent(m[1])); }
  else if ((m = hash.match(/^#\/driver\/(.+)$/))) { setActiveNav(""); renderDriver(decodeURIComponent(m[1])); }
  else if (hash.startsWith("#/season")) { setActiveNav("season"); setActiveDriver(null); renderSeason(); }
  else if (hash.startsWith("#/standings")) { setActiveNav("standings"); setActiveDriver(null); renderStandings(); }
  else if (hash.startsWith("#/champion")) { setActiveNav("champion"); setActiveDriver(null); renderChampion(); }
  else if (hash.startsWith("#/forecast")) { setActiveNav("forecast"); setActiveDriver(null); renderForecast(); }
  else if (hash.startsWith("#/prediction")) { setActiveNav("prediction"); setActiveDriver(null); renderPrediction(); }
  else { setActiveNav("latest"); setActiveDriver(null); renderLatest(); }
  view.focus({ preventScroll: true });
}

/* ============================================================
   Sidebar toggle (mobile)
   ============================================================ */
const sidebar = $("#sidebar"), scrim = $("#scrim"), menuToggle = $("#menuToggle");
function openSidebar() { sidebar.classList.add("is-open"); scrim.hidden = false; menuToggle.setAttribute("aria-expanded", "true"); }
function closeSidebar() { sidebar.classList.remove("is-open"); scrim.hidden = true; menuToggle.setAttribute("aria-expanded", "false"); }
menuToggle.addEventListener("click", () => sidebar.classList.contains("is-open") ? closeSidebar() : openSidebar());
scrim.addEventListener("click", closeSidebar);
view.addEventListener("click", (e) => { if (e.target.closest("a")) closeSidebar(); });

/* ============================================================
   Settings: background and accent colour. readDisplay() and
   applyDisplay() live in index.html, so the saved choice is applied
   before the first paint; this wires up the dialog that changes it.
   Choices are kept in this browser's localStorage.
   ============================================================ */
const settingsDlg = $("#settings"), settingsForm = $("#settingsForm");
function formDisplay() {
  const f = settingsForm.elements;
  return { background: f.background.value || "system", custom: f.custom.value, accent: f.accent.value };
}
function fillSettings(s) {
  const f = settingsForm.elements;
  f.background.value = s.background || "system";
  if (/^#[0-9a-f]{6}$/i.test(s.custom || "")) f.custom.value = s.custom;
  f.accent.value = s.accent || f.accent[0].value;   // the first swatch is the default
  paintCustomOption();
}
/* the "Custom" choice previews the picked colour, with readable text on it */
function paintCustomOption() {
  const v = settingsForm.elements.custom.value, opt = $(".bg-option--custom");
  opt.style.setProperty("--opt-bg", v);
  opt.style.setProperty("--opt-fg", luma(v) > 0.179 ? "#0f1419" : "#e7e9ea");
}
function saveDisplay(s) {
  applyDisplay(s);
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(s)); } catch (e) {}
}
$("#settingsOpen").addEventListener("click", () => { fillSettings(readDisplay()); closeSidebar(); settingsDlg.showModal(); });
settingsForm.addEventListener("change", () => saveDisplay(formDisplay()));
settingsForm.elements.custom.addEventListener("input", () => {
  settingsForm.elements.background.value = "custom";
  paintCustomOption();
  saveDisplay(formDisplay());
});
$("#settingsReset").addEventListener("click", () => {
  try { localStorage.removeItem(DISPLAY_KEY); localStorage.removeItem("f1hub-theme"); } catch (e) {}
  applyDisplay({});
  fillSettings({});
});
settingsDlg.addEventListener("click", (e) => { if (e.target === settingsDlg) settingsDlg.close(); });   // backdrop

/* ============================================================
   Boot
   ============================================================ */
detectDataSource().then(() => {
  window.addEventListener("hashchange", router);
  loadSidebarDrivers();
  router();
});
