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
   Reference data: team colours + nationality flags
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

const NAT_TO_ISO = {
  Dutch: "NL", British: "GB", English: "GB", German: "DE", Spanish: "ES",
  Italian: "IT", Monegasque: "MC", Australian: "AU", French: "FR", Finnish: "FI",
  Canadian: "CA", Mexican: "MX", Japanese: "JP", Thai: "TH", Argentine: "AR",
  Argentinian: "AR", Brazilian: "BR", "New Zealander": "NZ", Danish: "DK",
  American: "US", Chinese: "CN", Austrian: "AT", Belgian: "BE", Swiss: "CH",
  Russian: "RU", Swedish: "SE", Polish: "PL", Portuguese: "PT", Irish: "IE",
  Colombian: "CO", Venezuelan: "VE", Indonesian: "ID", "South African": "ZA",
};
function isoToFlag(iso) {
  if (!iso) return "🏁";
  return iso.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}
function flag(nationality) { return isoToFlag(NAT_TO_ISO[nationality]); }

/* Circuit country name -> ISO, for the race banner / season flags */
const COUNTRY_ISO = {
  Australia: "AU", China: "CN", Japan: "JP", USA: "US", "United States": "US",
  Canada: "CA", Monaco: "MC", Spain: "ES", Austria: "AT", UK: "GB",
  "United Kingdom": "GB", Belgium: "BE", Hungary: "HU", Netherlands: "NL",
  Italy: "IT", Azerbaijan: "AZ", Singapore: "SG", Mexico: "MX", Brazil: "BR",
  Qatar: "QA", UAE: "AE", "United Arab Emirates": "AE", Bahrain: "BH",
  "Saudi Arabia": "SA", Malaysia: "MY", France: "FR", Germany: "DE",
  Portugal: "PT", Turkey: "TR", Russia: "RU", "South Africa": "ZA",
};
function countryFlag(country) { return isoToFlag(COUNTRY_ISO[country]); }

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
            <span class="flag">${flag(d.nationality)}</span>
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

function raceBanner(race) {
  const loc = race.Circuit.Location;
  return `
    <div class="race-banner">
      <div class="race-banner__round">
        <span class="rnum">${esc(race.round)}</span>
        <span class="rlab">Round</span>
      </div>
      <div>
        <h1><span class="race-banner__flag">${countryFlag(loc.country)}</span> ${esc(race.raceName)}</h1>
        <div class="meta">
          <span><b>${esc(race.Circuit.circuitName)}</b></span>
          <span>${esc(loc.locality)}, ${esc(loc.country)}</span>
          <span>${fmtDate(race.date)}</span>
        </div>
      </div>
    </div>`;
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
      const team = r.Constructor.name, pc = teamColor(team);
      return `
        <article class="podium__card" style="--pc:${pc}" data-pos="${i + 1}">
          <div class="podium__place">${placeLabel[i]}</div>
          <div class="podium__name">${esc(fullName(r.Driver))}</div>
          <div class="podium__team"><span class="dot"></span>${esc(team)}</div>
          <div class="podium__stat">
            <div><span class="k">Time / Gap</span><span class="v">${esc(r.Time ? r.Time.time : r.status)}</span></div>
            <div><span class="k">Points</span><span class="v">+${esc(r.points)}</span></div>
          </div>
        </article>`;
    }).join("");

    view.innerHTML = `
      <div class="page-head" style="margin-bottom:14px">
        <span class="eyebrow">Latest Grand Prix · Round ${esc(race.round)}</span>
      </div>
      ${raceBanner(race)}
      <div class="podium">${podiumHTML}</div>
      <h2 class="section-title">Full classification</h2>
      ${resultsTable(results)}
      <p class="empty-note" style="font-size:13px">Tip: click any driver's name to open their season data.</p>
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
        ? `<span class="pill result">Results ›</span>`
        : isNext ? `<span class="pill next">Up next</span>`
                 : `<span class="pill soon">Scheduled</span>`;
      const tag = done ? "button" : "div";
      const attrs = done
        ? `class="race-cell done" data-round="${esc(r.round)}"`
        : `class="race-cell upcoming"`;
      return `
        <${tag} ${attrs}>
          <div class="race-cell__top">
            <span class="race-cell__round">R${esc(r.round)}</span>
            <span class="race-cell__flag">${countryFlag(loc.country)}</span>
          </div>
          <div class="race-cell__name">${esc(r.raceName.replace(/ Grand Prix$/, " GP"))}</div>
          <div class="race-cell__circuit">${esc(r.Circuit.circuitName)}</div>
          <div class="race-cell__foot">
            <span class="race-cell__date">${fmtDate(r.date)}</span>
            ${pill}
          </div>
        </${tag}>`;
    }).join("");

    view.innerHTML = `
      <div class="page-head">
        <span class="eyebrow">Calendar</span>
        <h1>${esc(season)} Season</h1>
        <p class="sub">${races.length} rounds · ${lastRound} completed. Open any finished round to view its full results.</p>
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
      <a class="back-link" href="#/season">‹ All races</a>
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
              <span class="flag">${flag(d.nationality)}</span>
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
        <span class="eyebrow">World Championship</span>
        <h1>${esc(season)} Drivers' Standings</h1>
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
      <div class="driver-hero" style="--team:${tc}">
        <div class="driver-hero__num">${esc(driver.permanentNumber || "")}</div>
        <div>
          <h1 class="driver-hero__name"><span class="flag">${flag(driver.nationality)}</span> ${esc(fullName(driver))}</h1>
          <div class="driver-hero__meta">
            <span><b>${esc(team)}</b></span>
            <span>${esc(driver.nationality)}</span>
            <span>Car <b>#${esc(driver.permanentNumber || "–")}</b></span>
            <span>${age} yrs</span>
            <span>Championship <b>${esc(ordinalSafe(champPos))}</b></span>
          </div>
        </div>
      </div>

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
      { k: "Winner", v: winner.name, meta: winner.team, c: winner.color },
      { k: "Pole position", v: poleName, meta: "Qualifying P1", c: "var(--accent)" },
      { k: "Fastest lap", v: flDriver ? flDriver.code : "—", meta: dyn.fastest ? `${fmtLap(dyn.fastest.t)} · L${dyn.fastest.lap}` : "no lap data", c: "var(--s5)" },
      { k: "Biggest climber", v: topMover ? `${topMover.code} +${topMover.delta}` : "—", meta: topMover ? `P${topMover.grid} → P${topMover.finish}` : "", c: "var(--pos-up)" },
      { k: "Lead changes", v: hasLaps ? String(dyn.leadChanges) : "—", meta: `${lastLap} laps`, c: "var(--s1)" },
      { k: "DNFs", v: String(dnfCount), meta: `${N - dnsCount} starters`, c: "var(--pos-down)" },
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
          <span class="eyebrow">Race Analytics · Round ${esc(race.round)}</span>
          <h1>${countryFlag(loc.country)} ${esc(race.raceName)}</h1>
          <p class="sub">${esc(race.Circuit.circuitName)} · ${esc(loc.locality)}, ${esc(loc.country)} · ${fmtDate(race.date)}</p>
        </div>
        <div class="round-select-wrap">
          <select class="round-select" id="roundSelect" aria-label="Choose a race">${options}</select>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </div>

      <div class="kpi-row">
        ${kpis.map((x) => `<div class="kpi" style="--kc:${x.c}"><div class="k">${esc(x.k)}</div><div class="v">${esc(x.v)}</div><div class="meta2">${esc(x.meta)}</div></div>`).join("")}
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

      <div class="pipeline">
        <span>Pipeline:</span>
        <span class="chip">${N} results</span>
        <span class="chip">${totalRows} lap rows</span>
        <span class="chip">${pitStops.length} pit stops</span>
        <span class="chip">${quali.length} quali times</span>
        <span>joined &amp; aggregated in your browser · source <b>${sourceName()}</b></span>
      </div>
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
    const stopsHTML = fastestStop.did === did ? `${stops} ⚡` : String(stops);
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
let allResultsCache = null;
let FC = null; // cached forecast inputs, so what-if scenarios re-run without re-fetching
async function getAllResults() {
  if (allResultsCache) return allResultsCache;
  const pointsByDriver = new Map();
  const roundsSet = new Set();
  const ingest = (resp) => {
    for (const race of resp.MRData.RaceTable.Races) {
      roundsSet.add(Number(race.round));
      for (const r of race.Results) {
        const did = r.Driver.driverId;
        if (!pointsByDriver.has(did)) pointsByDriver.set(did, []);
        pointsByDriver.get(did).push(Number(r.points));
      }
    }
  };
  const first = await getJSON(`current/results.json?limit=${PAGE}&offset=0`);
  const total = Number(first.MRData.total) || 0;
  ingest(first);
  for (let off = PAGE; off < total; off += PAGE) ingest(await getJSON(`current/results.json?limit=${PAGE}&offset=${off}`));
  allResultsCache = { pointsByDriver, rounds: [...roundsSet].sort((a, b) => a - b) };
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
        if (g !== 0) v = Math.min(26, Math.max(0, Math.round(v)));
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
    const MAX_PER_RACE = 26; // 25 for a win + 1 for fastest lap
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
      ? `<span class="status-pill clinched">● Title clinched by ${esc(leader.name)}</span>`
      : `<span class="status-pill open">● Title open — ${remaining} round${remaining === 1 ? "" : "s"} left</span>`;

    view.innerHTML = `
      <div class="page-head">
        <span class="eyebrow">Championship Forecast</span>
        <h1>${esc(season)} Title Projection</h1>
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
        <div class="kpi" style="--kc:var(--accent)"><div class="k">Rounds left</div><div class="v">${remaining}</div><div class="meta2">of ${totalRounds}</div></div>
        <div class="kpi" style="--kc:var(--s1)"><div class="k">Points still available</div><div class="v">${available}</div><div class="meta2">max ${MAX_PER_RACE}/race</div></div>
        <div class="kpi" style="--kc:${leader.color}"><div class="k">Leader</div><div class="v">${esc(leader.code)}</div><div class="meta2">${leader.current} pts</div></div>
        <div class="kpi" style="--kc:var(--s5)"><div class="k">Lead margin</div><div class="v">${margin}</div><div class="meta2">over P2</div></div>
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

      <div class="pipeline">
        <span>Pipeline:</span>
        <span class="chip">${all.rounds.length} races sampled</span>
        <span class="chip">${drivers.length} drivers</span>
        <span class="chip">5,000 sims × ${remaining} rounds</span>
        <span>bootstrap Monte-Carlo in your browser · source <b>${sourceName()}</b></span>
      </div>
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
    const champStr = champPct >= 99.95 ? "✓" : champPct >= 9.95 ? champPct.toFixed(0) + "%" : champPct >= 0.05 ? champPct.toFixed(1) + "%" : "—";
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
   Sidebar: driver dropdown
   ============================================================ */
async function loadSidebarDrivers() {
  const sel = $("#driverSelect");
  try {
    const data = await getJSON("current/driverstandings.json");
    const list = data.MRData.StandingsTable.StandingsLists[0];
    $("#brandSeason").textContent = data.MRData.StandingsTable.season;
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
  else if (hash.startsWith("#/forecast")) { setActiveNav("forecast"); setActiveDriver(null); renderForecast(); }
  else { setActiveNav("latest"); setActiveDriver(null); renderLatest(); }
  view.focus({ preventScroll: true });
}

/* ============================================================
   Sidebar toggle (mobile) + theme toggle
   ============================================================ */
const sidebar = $("#sidebar"), scrim = $("#scrim"), menuToggle = $("#menuToggle");
function openSidebar() { sidebar.classList.add("is-open"); scrim.hidden = false; menuToggle.setAttribute("aria-expanded", "true"); }
function closeSidebar() { sidebar.classList.remove("is-open"); scrim.hidden = true; menuToggle.setAttribute("aria-expanded", "false"); }
menuToggle.addEventListener("click", () => sidebar.classList.contains("is-open") ? closeSidebar() : openSidebar());
scrim.addEventListener("click", closeSidebar);
view.addEventListener("click", (e) => { if (e.target.closest("a")) closeSidebar(); });

const themeToggle = $("#themeToggle");
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("f1hub-theme", t); } catch (e) {}
}
function currentTheme() {
  const set = document.documentElement.getAttribute("data-theme");
  if (set) return set;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
themeToggle.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark"));
try { const saved = localStorage.getItem("f1hub-theme"); if (saved) applyTheme(saved); } catch (e) {}

/* ============================================================
   Boot
   ============================================================ */
detectDataSource().then(() => {
  window.addEventListener("hashchange", router);
  loadSidebarDrivers();
  router();
});
