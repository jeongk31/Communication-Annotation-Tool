"""Multi-page admin dashboard (served at /admin). Data is injected as JSON where
the /*__DATA__*/ placeholder appears; all rendering happens client-side.

Design: a polished light/dark analytics dashboard. The Runs and Sessions views are
the core: a "run" is one Run Coding action (with its outcome — completed / failed /
stopped / abandoned), and a "session" groups everything one browser did."""

ADMIN_HTML = r"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CAT — Admin</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/jsvectormap@1.5.3/dist/css/jsvectormap.min.css">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/jsvectormap@1.5.3/dist/js/jsvectormap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/jsvectormap@1.5.3/dist/maps/world.js"></script>
<style>
  :root{
    --pur:#7c3aed; --pur-2:#a78bfa; --pur-soft:#ede9fe;
    --bg:#f6f7f9; --surface:#ffffff; --surface-2:#fafafe;
    --ink:#18181b; --ink-2:#3f3f46; --mut:#71717a; --faint:#a1a1aa;
    --line:#e6e8ee; --line-2:#f1f1f4;
    --green:#16a34a; --green-bg:#dcfce7; --red:#dc2626; --red-bg:#fee2e2;
    --amber:#d97706; --amber-bg:#fef3c7; --blue:#2563eb; --blue-bg:#dbeafe;
    --slate:#64748b; --slate-bg:#e2e8f0;
    --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);
    --shadow-lg:0 4px 16px rgba(16,24,40,.08);
    --sidebar:#1c1230;
  }
  :root[data-theme="dark"]{
    --bg:#0f1117; --surface:#171a21; --surface-2:#1c2029;
    --ink:#f4f4f5; --ink-2:#d4d4d8; --mut:#a1a1aa; --faint:#71717a;
    --line:#282c36; --line-2:#21242d;
    --pur-soft:#2a1b45;
    --green-bg:#0f2c1b; --red-bg:#3a1516; --amber-bg:#3a2a0c; --blue-bg:#132444; --slate-bg:#20293a;
    --shadow:0 1px 2px rgba(0,0,0,.3); --shadow-lg:0 6px 24px rgba(0,0,0,.4);
    --sidebar:#14101f;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);
    background:var(--bg);display:flex;min-height:100vh;font-size:14px;-webkit-font-smoothing:antialiased}
  a{color:var(--pur);text-decoration:none}
  ::selection{background:var(--pur);color:#fff}

  /* sidebar */
  .side{width:224px;background:var(--sidebar);color:#e9e3f5;padding:20px 14px;flex-shrink:0;
    position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:10px;padding:2px 8px 18px}
  .brand-mark{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--pur),var(--pur-2));
    display:grid;place-items:center;font-weight:800;color:#fff;font-size:15px}
  .brand h2{font-size:15px;margin:0;color:#fff;line-height:1.1}
  .brand .tag{font-size:10px;color:#b9a7e6;text-transform:uppercase;letter-spacing:.08em}
  .nav{display:flex;flex-direction:column;gap:2px;margin-top:6px}
  .nav button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;
    color:#cdc2e8;font-size:13px;padding:9px 11px;border-radius:8px;cursor:pointer;font-family:inherit;transition:background .12s}
  .nav button:hover{background:rgba(255,255,255,.07)}
  .nav button.active{background:linear-gradient(135deg,var(--pur),#6d28d9);color:#fff;box-shadow:0 2px 8px rgba(124,58,237,.4)}
  .nav .ico{width:16px;text-align:center;font-size:14px}
  .nav .badge{margin-left:auto;background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px}
  .side-foot{margin-top:auto;padding-top:14px}
  .theme-btn{display:flex;align-items:center;gap:8px;width:100%;background:rgba(255,255,255,.06);border:none;
    color:#cdc2e8;font-size:12px;padding:8px 11px;border-radius:8px;cursor:pointer;font-family:inherit}
  .theme-btn:hover{background:rgba(255,255,255,.12)}

  /* main */
  .main{flex:1;padding:24px 30px 60px;overflow:auto;max-width:1240px}
  .view{display:none;animation:fade .18s ease} .view.active{display:block}
  @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  .head{margin-bottom:20px}
  h1{font-size:21px;margin:0 0 3px;letter-spacing:-.02em} .sub{color:var(--mut);font-size:12.5px}
  h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:26px 0 10px;font-weight:700}

  /* cards */
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:13px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 17px;box-shadow:var(--shadow)}
  .card .v{font-size:27px;font-weight:750;line-height:1.05;letter-spacing:-.02em}
  .card .l{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;margin-top:5px;display:flex;align-items:center;gap:5px}
  .card .hint{font-size:10.5px;color:var(--faint);margin-top:3px;font-weight:400;text-transform:none;letter-spacing:0}
  .card.accent{background:linear-gradient(135deg,var(--pur),#6d28d9);border-color:transparent;color:#fff}
  .card.accent .l,.card.accent .hint{color:rgba(255,255,255,.85)}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block}

  /* panels & charts */
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
  .charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:15px}
  .chart-box{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 17px;box-shadow:var(--shadow)}
  .chart-box h4{margin:0 0 12px;font-size:12px;color:var(--ink-2);font-weight:600}
  .grid-2{display:grid;grid-template-columns:1.3fr 1fr;gap:15px;align-items:start}
  @media(max-width:820px){.grid-2{grid-template-columns:1fr}}
  #worldmap{height:460px;width:100%}

  /* tables */
  .tbl-wrap{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:auto;box-shadow:var(--shadow)}
  table{border-collapse:collapse;width:100%;font-size:12.5px}
  td,th{padding:9px 14px;border-bottom:1px solid var(--line-2);text-align:left;white-space:nowrap}
  tbody tr:last-child td{border-bottom:none}
  th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);background:var(--surface-2);
    position:sticky;top:0;font-weight:700}
  tbody tr{transition:background .1s}
  tbody tr:hover{background:var(--surface-2)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
  .muted{color:var(--faint)} .num{text-align:right;font-variant-numeric:tabular-nums}
  .small{font-size:10.5px;max-width:230px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}

  /* pills */
  .pill{font-size:10px;font-weight:700;padding:2px 9px;border-radius:20px;text-transform:capitalize;letter-spacing:.02em;white-space:nowrap}
  .p-completed{background:var(--green-bg);color:var(--green)}
  .p-failed{background:var(--red-bg);color:var(--red)}
  .p-stopped{background:var(--amber-bg);color:var(--amber)}
  .p-abandoned{background:var(--slate-bg);color:var(--slate)}
  .p-visit{background:var(--blue-bg);color:var(--blue)} .p-run{background:var(--pur-soft);color:var(--pur)}
  .p-run_complete{background:var(--green-bg);color:var(--green)}
  .chip{display:inline-block;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;
    padding:1px 7px;font-size:10.5px;margin:1px 3px 1px 0}

  /* filters */
  .filter{display:flex;gap:7px;margin-bottom:16px;flex-wrap:wrap}
  .filter button{font-size:12px;padding:6px 13px;border-radius:20px;border:1px solid var(--line);
    background:var(--surface);color:var(--mut);cursor:pointer;font-family:inherit;transition:all .12s}
  .filter button:hover{border-color:var(--pur-2)}
  .filter button.active{background:var(--pur);color:#fff;border-color:var(--pur)}
  .search{width:100%;max-width:320px;padding:8px 12px;border:1px solid var(--line);border-radius:9px;
    background:var(--surface);color:var(--ink);font-size:13px;font-family:inherit;margin-bottom:14px}
  .search:focus{outline:none;border-color:var(--pur)}

  /* expandable session rows */
  tr.sess-row{cursor:pointer} tr.sess-row .caret{transition:transform .15s;display:inline-block;color:var(--faint)}
  tr.sess-row.open .caret{transform:rotate(90deg)}
  tr.detail-row>td{padding:0;background:var(--surface-2)}
  .detail-inner{padding:6px 14px 12px 34px}
  .detail-inner table{background:transparent}
  .detail-inner th{background:transparent}

  /* messages */
  #msg-list{max-width:840px}
  .msg{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px;box-shadow:var(--shadow)}
  .msg-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:10px}
  .msg-who{display:flex;flex-direction:column;gap:2px;min-width:0}
  .msg-name{font-weight:700;font-size:14px} .msg-email{font-size:12.5px;color:var(--mut);word-break:break-all}
  .msg-meta{display:flex;align-items:center;gap:10px;flex-shrink:0}
  .msg-when{font-size:11px;color:var(--faint);white-space:nowrap}
  .msg-title{font-weight:600;font-size:13.5px;margin:0 0 6px;padding-top:10px;border-top:1px solid var(--line-2)}
  .msg-body{font-size:13px;color:var(--ink-2);line-height:1.6;white-space:pre-wrap;word-wrap:break-word}
  .msg-actions{display:flex;gap:8px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--line-2)}
  .st{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:20px;text-transform:uppercase;letter-spacing:.03em}
  .st-unresolved{background:var(--amber-bg);color:var(--amber)} .st-resolved{background:var(--green-bg);color:var(--green)}
  .btn{font-family:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:7px 13px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink)}
  .btn:hover{border-color:var(--pur-2)} .btn-p{background:var(--pur);color:#fff;border-color:var(--pur)}
  .empty{color:var(--faint);padding:36px;text-align:center;font-size:13px}
  /* errors */
  .err{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--red);border-radius:10px;padding:13px 16px;margin-bottom:11px;box-shadow:var(--shadow)}
  .err-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;font-size:12px;color:var(--mut)}
  .err-msgs{margin:0;padding-left:16px;font-size:12px;color:var(--ink-2);line-height:1.6;font-family:ui-monospace,Menlo,monospace}
  .err-msgs li{margin:2px 0;word-break:break-word}
</style></head>
<body>
<div class="side">
  <div class="brand">
    <div class="brand-mark">C</div>
    <div><h2>CAT Admin</h2><div class="tag">Usage &amp; runs</div></div>
  </div>
  <div class="nav">
    <button data-view="home" class="active"><span class="ico">◎</span> Overview</button>
    <button data-view="versions"><span class="ico">⎘</span> Version history</button>
    <button data-view="runs"><span class="ico">▶</span> Coding runs</button>
    <button data-view="errors"><span class="ico">⚠</span> Errors <span class="badge" id="err-badge" style="display:none"></span></button>
    <button data-view="sessions"><span class="ico">◇</span> Sessions</button>
    <button data-view="analytics"><span class="ico">▤</span> Analytics</button>
    <button data-view="map"><span class="ico">◍</span> Map</button>
    <button data-view="logs"><span class="ico">≡</span> Event log</button>
    <button data-view="messages"><span class="ico">✉</span> Messages <span class="badge" id="msg-badge" style="display:none"></span></button>
  </div>
  <div class="side-foot">
    <button class="theme-btn" id="theme-btn"><span id="theme-ico">◐</span> <span id="theme-label">Theme</span></button>
  </div>
</div>
<div class="main">
  <!-- OVERVIEW -->
  <section class="view active" id="view-home">
    <div class="head"><h1>Overview</h1><div class="sub">Metadata only — no API keys or dataset content is stored. Times in UAE (GST, UTC+4).</div></div>
    <div class="cards" id="home-cards"></div>
    <div class="grid-2" style="margin-top:22px">
      <div class="chart-box"><h4>Activity over time</h4><canvas id="c-home-day" height="150"></canvas></div>
      <div class="chart-box"><h4>Run outcomes</h4><canvas id="c-home-outcome" height="150"></canvas></div>
    </div>
  </section>

  <!-- VERSION HISTORY -->
  <section class="view" id="view-versions">
    <div class="head"><h1>Version history</h1><div class="sub">Every version deployed to production, newest first. The website shows the major version (e.g. v1.2); each deploy adds a patch (1.2.1, 1.2.2, …).</div></div>
    <div class="cards" id="ver-cards" style="margin-bottom:18px"></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Version</th><th>Date</th><th>What changed</th></tr></thead>
      <tbody id="ver-rows"></tbody>
    </table></div>
  </section>

  <!-- RUNS -->
  <section class="view" id="view-runs">
    <div class="head"><h1>Coding runs</h1>
      <div class="sub">Every time someone launched <b>Run Coding</b>, with what happened. A run is <b>completed</b>, <b>failed</b>, <b>stopped</b> by the user, or <b>abandoned</b> (left before it finished).</div></div>
    <div class="cards" id="runs-cards" style="margin-bottom:18px"></div>
    <div class="filter" id="runs-filter">
      <button data-f="all" class="active">All</button>
      <button data-f="completed">Completed</button>
      <button data-f="failed">Failed</button>
      <button data-f="stopped">Stopped</button>
      <button data-f="abandoned">Abandoned</button>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>When (UAE)</th><th>Status</th><th>Session</th><th>Models</th><th class="num">Calls/model</th><th class="num">Variables</th><th class="num">Rows</th><th class="num">Episodes coded</th><th class="num">Errors</th><th class="num">Duration</th><th>Location</th></tr></thead>
      <tbody id="runs-rows"></tbody>
    </table></div>
  </section>

  <!-- ERRORS -->
  <section class="view" id="view-errors">
    <div class="head"><h1>Errors</h1><div class="sub">Any error that happened, newest first — backend exceptions and coding-run errors, with their actual messages.</div></div>
    <div class="cards" id="err-cards" style="margin-bottom:18px"></div>
    <h3>Server errors (backend)</h3>
    <div id="srv-err-list"></div>
    <h3>Coding-run errors</h3>
    <div id="err-list"></div>
  </section>

  <!-- SESSIONS -->
  <section class="view" id="view-sessions">
    <div class="head"><h1>Sessions</h1><div class="sub">Everything one browser did, grouped. Click a row to see that session's runs. A session is one anonymous browser (no login).</div></div>
    <input class="search" id="sess-search" placeholder="Filter by session id, country, or model…">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Session</th><th>First seen</th><th>Last seen</th><th>Location</th><th class="num">Visits</th><th class="num">Runs</th><th>Models</th><th class="num">Episodes</th></tr></thead>
      <tbody id="sess-rows"></tbody>
    </table></div>
  </section>

  <!-- ANALYTICS -->
  <section class="view" id="view-analytics">
    <div class="head"><h1>Analytics</h1><div class="sub">Coding runs broken down by configuration and outcome.</div></div>
    <div class="charts">
      <div class="chart-box"><h4>Events by day</h4><canvas id="c-day"></canvas></div>
      <div class="chart-box"><h4>Run outcomes</h4><canvas id="c-status"></canvas></div>
      <div class="chart-box"><h4>Runs by provider</h4><canvas id="c-provider"></canvas></div>
      <div class="chart-box"><h4>Runs by model</h4><canvas id="c-model"></canvas></div>
      <div class="chart-box"><h4>Runs by aggregation</h4><canvas id="c-agg"></canvas></div>
      <div class="chart-box"><h4>Calls per model</h4><canvas id="c-rpm"></canvas></div>
      <div class="chart-box"><h4>Top countries</h4><canvas id="c-country"></canvas></div>
    </div>
  </section>

  <!-- MAP -->
  <section class="view" id="view-map">
    <div class="head"><h1>Where it's used</h1><div class="sub">Events by country (best-effort from visitor IP).</div></div>
    <div class="panel"><div id="worldmap"></div></div>
    <h3>By country</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Country</th><th class="num">Events</th></tr></thead><tbody id="country-rows"></tbody></table></div>
  </section>

  <!-- LOGS -->
  <section class="view" id="view-logs">
    <div class="head"><h1>Event log</h1><div class="sub" id="logs-sub"></div></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>When (UAE)</th><th>Event</th><th>Recorded by</th><th>Session</th><th>Location</th><th>IP</th><th>Models</th><th class="num">Rows</th><th class="num">Episodes</th><th>Status</th><th>User agent</th></tr></thead>
      <tbody id="log-rows"></tbody>
    </table></div>
  </section>

  <!-- MESSAGES -->
  <section class="view" id="view-messages">
    <div class="head"><h1>Questions &amp; concerns</h1><div class="sub">Submissions from the contact form. Mark them resolved once handled; use “Reply” to email the sender.</div></div>
    <div class="filter">
      <button data-filter="all" class="active">All</button>
      <button data-filter="unresolved">Unresolved</button>
      <button data-filter="resolved">Resolved</button>
    </div>
    <div id="msg-list"></div>
  </section>
</div>

<script id="chat-data" type="application/json">/*__DATA__*/</script>
<script>
const DATA = JSON.parse(document.getElementById('chat-data').textContent);
let S = DATA.stats, MSGS = DATA.messages || [];
const PALETTE = ['#7c3aed','#a78bfa','#c4b5fd','#f0abfc','#60a5fa','#34d399','#fbbf24','#f87171'];
const STATUS_COLOR = {completed:'#16a34a', failed:'#dc2626', stopped:'#d97706', abandoned:'#64748b'};

// ---- theme ----
const root = document.documentElement;
function applyTheme(t){
  root.setAttribute('data-theme', t);
  document.getElementById('theme-ico').textContent = t==='dark' ? '☀' : '☾';
  document.getElementById('theme-label').textContent = t==='dark' ? 'Light mode' : 'Dark mode';
  try{ localStorage.setItem('cat_admin_theme', t); }catch(e){}
  if(window.__charts) redrawCharts();
}
(function(){
  let t; try{ t = localStorage.getItem('cat_admin_theme'); }catch(e){}
  if(!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
})();
document.getElementById('theme-btn').addEventListener('click', () =>
  applyTheme(root.getAttribute('data-theme')==='dark' ? 'light' : 'dark'));

// ---- nav ----
document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.nav button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + b.dataset.view).classList.add('active');
  if (b.dataset.view === 'map') setTimeout(initMap, 30);
}));

// ---- helpers ----
function el(tag, cls, txt){ const e = document.createElement(tag); if(cls) e.className = cls; if(txt!=null) e.textContent = txt; return e; }
function entries(o){ return Object.entries(o || {}); }
function td(val, cls){ const e = el('td', cls); if(val instanceof Node) e.appendChild(val); else e.textContent = (val==null||val==='')?'':val; return e; }
function pill(status){ return el('span', 'pill p-' + status, status); }
function fmtDur(ms){ if(!ms||ms<0) return '—'; const s=Math.round(ms/1000); if(s<60) return s+'s'; const m=Math.floor(s/60); return m+'m '+(s%60)+'s'; }
function modelChips(models){ const w=el('span'); (models||[]).slice(0,4).forEach(m=>w.appendChild(el('span','chip',m))); if((models||[]).length>4) w.appendChild(el('span','muted',' +'+(models.length-4))); if(!(models||[]).length) w.appendChild(el('span','muted','—')); return w; }
function themeAxis(){ return root.getAttribute('data-theme')==='dark' ? '#a1a1aa' : '#71717a'; }
function gridColor(){ return root.getAttribute('data-theme')==='dark' ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)'; }

// ---- overview cards ----
function renderHomeCards(){
  const counts = DATA.counts || {};
  const homeStats = [
    {v:S.visits, l:'Visits'}, {v:S.unique_visitors, l:'Unique visitors'}, {v:S.countries, l:'Countries'},
    {v:S.runs, l:'Runs in the interface', hint:'Run Coding launches, incl. re-runs'},
    {v:S.runs_completed, l:'Completed', accent:true, hint:(S.success_rate||0)+'% success'},
    {v:S.package_downloads||0, l:'Packages downloaded', hint:'coded offline with the script'},
    {v:S.total_episodes_coded||0, l:'Episodes coded', hint:'episodes × models × runs'},
    {v:counts.unresolved||0, l:'Open messages'},
  ];
  const hc = document.getElementById('home-cards'); hc.innerHTML = '';
  homeStats.forEach(s => {
    const c = el('div', 'card' + (s.accent?' accent':''));
    c.appendChild(el('div','v', String(s.v)));
    c.appendChild(el('div','l', s.l));
    if(s.hint) c.appendChild(el('div','hint', s.hint));
    hc.appendChild(c);
  });
}
renderHomeCards();

// ---- version history ----
const REL = DATA.releases || [];
(function(){
  const cards = document.getElementById('ver-cards');
  if (cards) {
    const cur = el('div','card accent');
    cur.appendChild(el('div','v', 'v' + (DATA.version || (REL[0] && REL[0].version) || '?')));
    cur.appendChild(el('div','l','Current version'));
    if (REL[0]) cur.appendChild(el('div','hint','deployed ' + REL[0].date));
    cards.appendChild(cur);
    const cnt = el('div','card');
    cnt.appendChild(el('div','v', String(REL.length)));
    cnt.appendChild(el('div','l','Releases'));
    cards.appendChild(cnt);
  }
  const body = document.getElementById('ver-rows');
  if (body) {
    if (!REL.length) { body.innerHTML = '<tr><td colspan="3" class="muted" style="text-align:center;padding:30px">No release history.</td></tr>'; }
    REL.forEach((r,i) => {
      const tr = el('tr');
      const vc = el('td');
      const vs = el('span','mono'); vs.textContent = 'v' + r.version; vc.appendChild(vs);
      if (i===0) { vc.appendChild(document.createTextNode(' ')); vc.appendChild(el('span','pill p-completed','current')); }
      tr.appendChild(vc);
      tr.appendChild(td(r.date));
      const wc = el('td'); wc.style.whiteSpace='normal';
      const t = el('div', null, r.title || ''); t.style.fontWeight='600';
      wc.appendChild(t);
      if (r.notes) { const n = el('div','muted', r.notes); n.style.fontSize='11.5px'; n.style.marginTop='2px'; wc.appendChild(n); }
      tr.appendChild(wc);
      body.appendChild(tr);
    });
  }
})();

// ---- runs summary cards ----
function renderRunsCards(){
  const rc = document.getElementById('runs-cards'); rc.innerHTML = '';
  [['Started',S.runs,null],['Completed',S.runs_completed,'completed'],['Failed',S.runs_failed,'failed'],
   ['Stopped',S.runs_stopped,'stopped'],['Abandoned',S.runs_abandoned,'abandoned'],
   ['Success rate',(S.success_rate||0)+'%',null],['Avg duration',fmtDur(S.avg_duration_ms),null],
   ['Avg episodes / run',S.avg_episodes||0,null],['Packages downloaded',S.package_downloads||0,null],
   ['Recorded by the server',S.runs_recorded_by_server||0,null],
   ['Also reported by the browser',S.runs_reported_by_browser||0,null]]
  .forEach(([l,v,st]) => {
    const c = el('div','card');
    c.appendChild(el('div','v', String(v)));
    const ll = el('div','l');
    if(st){ const d=el('span','dot'); d.style.background=STATUS_COLOR[st]; ll.appendChild(d); }
    ll.appendChild(document.createTextNode(l));
    c.appendChild(ll);
    rc.appendChild(c);
  });
}
renderRunsCards();

// ---- runs table ----
let RUNS = S.runs_list || [];
let runFilter = 'all';
function renderRuns(){
  const body = document.getElementById('runs-rows'); body.innerHTML = '';
  const items = RUNS.filter(r => runFilter==='all' || r.status===runFilter);
  if(!items.length){ body.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:30px">No runs.</td></tr>'; return; }
  items.forEach(r => {
    const tr = el('tr');
    tr.appendChild(td(r.at));
    tr.appendChild(td(pill(r.status)));
    tr.appendChild(td(r.session || '—', 'mono'));
    tr.appendChild(td(modelChips(r.models)));
    tr.appendChild(td(r.runs_per_model||'—','num'));
    tr.appendChild(td(r.variables||'—','num'));
    tr.appendChild(td(r.rows||'—','num'));
    tr.appendChild(td(r.episodes_coded==null?'—':r.episodes_coded,'num'));
    tr.appendChild(td(r.error_count==null?'—':r.error_count,'num'));
    tr.appendChild(td(r.duration_ms==null?'—':fmtDur(r.duration_ms),'num'));
    tr.appendChild(td([r.country, r.city].filter(Boolean).join(' · ') || '—'));
    body.appendChild(tr);
  });
}
document.querySelectorAll('#runs-filter button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#runs-filter button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); runFilter = b.dataset.f; renderRuns();
}));
renderRuns();

// ---- sessions table (expandable) ----
let SESS = S.sessions || [];
function renderSessions(q){
  const body = document.getElementById('sess-rows'); body.innerHTML = '';
  q = (q||'').toLowerCase().trim();
  const items = SESS.filter(s => !q || (s.id||'').toLowerCase().includes(q) ||
    (s.country||'').toLowerCase().includes(q) || (s.models||[]).join(' ').toLowerCase().includes(q));
  if(!items.length){ body.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">No sessions.</td></tr>'; return; }
  items.forEach(s => {
    const tr = el('tr','sess-row');
    const c = el('td');
    c.appendChild(el('span','caret','▸'));
    c.appendChild(document.createTextNode(' '));
    const ids = el('span','mono', s.short || '—'); c.appendChild(ids);
    tr.appendChild(c);
    tr.appendChild(td(s.first)); tr.appendChild(td(s.last));
    tr.appendChild(td([s.country, s.city].filter(Boolean).join(' · ') || '—'));
    tr.appendChild(td(s.visits||0,'num'));
    tr.appendChild(td(s.runs||0,'num'));
    tr.appendChild(td(modelChips(s.models)));
    tr.appendChild(td(s.episodes||0,'num'));
    body.appendChild(tr);

    const detail = el('tr','detail-row'); detail.style.display='none';
    const dc = el('td'); dc.colSpan = 8;
    const inner = el('div','detail-inner');
    if((s.run_list||[]).length){
      const t = el('table');
      t.innerHTML = '<thead><tr><th>When</th><th>Status</th><th>Models</th><th class="num">Calls</th><th class="num">Episodes coded</th><th class="num">Errors</th><th class="num">Duration</th></tr></thead>';
      const tb = el('tbody');
      s.run_list.forEach(r => {
        const rr = el('tr');
        rr.appendChild(td(r.at)); rr.appendChild(td(pill(r.status)));
        rr.appendChild(td(modelChips(r.models))); rr.appendChild(td(r.runs_per_model||'—','num'));
        rr.appendChild(td(r.episodes_coded==null?'—':r.episodes_coded,'num'));
        rr.appendChild(td(r.error_count==null?'—':r.error_count,'num'));
        rr.appendChild(td(r.duration_ms==null?'—':fmtDur(r.duration_ms),'num'));
        tb.appendChild(rr);
      });
      t.appendChild(tb); inner.appendChild(t);
    } else { inner.appendChild(el('div','muted','No coding runs in this session (visited only).')); }
    dc.appendChild(inner); detail.appendChild(dc); body.appendChild(detail);

    tr.addEventListener('click', () => {
      const open = tr.classList.toggle('open');
      detail.style.display = open ? 'table-row' : 'none';
    });
  });
}
document.getElementById('sess-search').addEventListener('input', e => renderSessions(e.target.value));
renderSessions('');

// ---- charts ----
window.__charts = [];
function mkChart(id, type, labels, data, opts){
  const c = document.getElementById(id); if(!c || !window.Chart) return;
  const axis = themeAxis(), grid = gridColor();
  const colors = (opts && opts._colors) || labels.map((_,i)=>PALETTE[i%PALETTE.length]);
  const ch = new Chart(c, { type, data: { labels, datasets: [{ data,
      backgroundColor: type==='line' ? 'rgba(124,58,237,.14)' : colors,
      borderColor: type==='line' ? '#7c3aed' : (root.getAttribute('data-theme')==='dark'?'#171a21':'#fff'),
      borderWidth: type==='line'?2:(type==='bar'?0:2), fill: type==='line', tension:.35,
      pointRadius: type==='line'?2:0, pointBackgroundColor:'#7c3aed' }] },
    options: Object.assign({ responsive:true, maintainAspectRatio:true,
      plugins:{legend:{display:type==='doughnut', position:'bottom', labels:{boxWidth:10,font:{size:10},color:axis}}},
      scales: type==='doughnut'?{}:{ x:{ticks:{color:axis,font:{size:10}},grid:{display:false}},
        y:{beginAtZero:true,ticks:{precision:0,color:axis,font:{size:10}},grid:{color:grid}} } }, opts||{}) });
  window.__charts.push({id, type, labels, data, opts}); return ch;
}
function drawAllCharts(){
  window.__charts = [];
  const days = entries(S.by_day);
  mkChart('c-home-day','line', days.map(d=>d[0]), days.map(d=>d[1]));
  mkChart('c-day','line', days.map(d=>d[0]), days.map(d=>d[1]));
  const st = entries(S.by_status);
  mkChart('c-home-outcome','doughnut', st.map(x=>x[0]), st.map(x=>x[1]), {_colors: st.map(x=>STATUS_COLOR[x[0]]||'#a78bfa')});
  mkChart('c-status','doughnut', st.map(x=>x[0]), st.map(x=>x[1]), {_colors: st.map(x=>STATUS_COLOR[x[0]]||'#a78bfa')});
  const prov = entries(S.by_provider); mkChart('c-provider','doughnut', prov.map(x=>x[0]), prov.map(x=>x[1]));
  const mod = entries(S.by_model); mkChart('c-model','bar', mod.map(x=>x[0]), mod.map(x=>x[1]));
  const agg = entries(S.by_aggregation); mkChart('c-agg','doughnut', agg.map(x=>x[0]), agg.map(x=>x[1]));
  const rpm = entries(S.by_runs_per_model); mkChart('c-rpm','bar', rpm.map(x=>x[0]), rpm.map(x=>x[1]));
  const ctry = entries(S.by_country).slice(0,10); mkChart('c-country','bar', ctry.map(x=>x[0]), ctry.map(x=>x[1]));
}
function redrawCharts(){ try{ Chart.helpers.each(Chart.instances, c=>c.destroy()); }catch(e){ try{ Object.values(Chart.instances||{}).forEach(c=>c.destroy()); }catch(e2){} } drawAllCharts(); }
try { drawAllCharts(); } catch(e){ console.warn('charts', e); }

// ---- map ----
let mapInited = false;
function initMap(){
  if (mapInited) return; mapInited = true;
  try {
    if (!window.jsVectorMap) return;
    const cc = S.by_country_code || {}; const counts = {};
    Object.keys(cc).forEach(k => { counts[k.toUpperCase()] = cc[k]; counts[k.toLowerCase()] = cc[k]; });
    // Every country with recorded activity gets the same purple; the map answers
    // "where has this been used", and shading by volume buried the quiet ones.
    //
    // jsvectormap 1.5 only has an ORDINAL scale: it looks the region's value up in
    // `scale` as a key. Handing it a colour array and a raw count means
    // scale[24] === undefined and the country renders black. So mark each used
    // country with the key 1 and map that key to the colour.
    const scale = { 1: '#7c3aed' };
    const values = {};
    Object.keys(counts).forEach(k => { if (counts[k] > 0) values[k] = 1; });
    new jsVectorMap({ selector:'#worldmap', map:'world', zoomButtons:true,
      regionStyle:{ initial:{ fill: root.getAttribute('data-theme')==='dark'?'#2a2f3a':'#e5e7eb', stroke:'#fff', strokeWidth:.4 } },
      series:{ regions:[{ attribute:'fill', scale, values }] },
      onRegionTooltipShow(ev, tooltip, code){ try { tooltip.text(tooltip.text() + ' — ' + (counts[code] || 0) + ' events'); } catch(e){} } });
  } catch(e){ mapInited = false; }
}
const crows = document.getElementById('country-rows');
entries(S.by_country).forEach(([k,v]) => { const tr = el('tr'); tr.appendChild(td(k)); tr.appendChild(td(String(v),'num')); crows.appendChild(tr); });
if(!entries(S.by_country).length) crows.innerHTML = '<tr><td colspan="2" class="muted">No data yet</td></tr>';

// ---- event log ----
function renderEventLog(){
  document.getElementById('logs-sub').textContent = 'Latest ' + (S.events||[]).length + ' raw events (advanced).';
  const lrows = document.getElementById('log-rows'); lrows.innerHTML = '';
  (S.events||[]).forEach(r => {
    const tr = el('tr');
    tr.appendChild(td(r.at));
    tr.appendChild(td(pill(r.event)));
    tr.appendChild(td(r.source||'browser','small muted'));
    tr.appendChild(td(r.session||'—','mono'));
    tr.appendChild(td([r.country, r.city].filter(Boolean).join(' · ') || '—'));
    tr.appendChild(td(r.ip||'—','mono'));
    tr.appendChild(td((r.models||[]).join(', ')||'—'));
    tr.appendChild(td(r.rows||'','num'));
    tr.appendChild(td(r.episodes||'','num'));
    tr.appendChild(td(r.status?pill(r.status==='started'?'run':r.status):'', ''));
    const ua = el('td'); ua.appendChild(el('span','small muted', r.user_agent||'')); tr.appendChild(ua);
    lrows.appendChild(tr);
  });
  if(!(S.events||[]).length) lrows.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:30px">No events yet</td></tr>';
}
renderEventLog();

// ---- errors view ----
function renderErrors(){
  const list = document.getElementById('err-list'); if(!list) return;
  const errRuns = (RUNS||[]).filter(r => (r.error_count && r.error_count>0) || r.status==='failed');
  const srvErrors = DATA.server_errors || [];
  const cards = document.getElementById('err-cards'); cards.innerHTML='';
  [['Server errors',srvErrors.length,'failed'],
   ['Failed runs',(RUNS||[]).filter(r=>r.status==='failed').length,'failed'],
   ['Runs with errors',errRuns.length,null],
   ['Total run-error messages',errRuns.reduce((a,r)=>a+(r.error_count||0),0),null]]
  .forEach(([l,v,st])=>{ const c=el('div','card'); c.appendChild(el('div','v',String(v))); const ll=el('div','l'); if(st){const d=el('span','dot');d.style.background=STATUS_COLOR[st];ll.appendChild(d);} ll.appendChild(document.createTextNode(l)); c.appendChild(ll); cards.appendChild(c); });
  const badge=document.getElementById('err-badge');
  const total = errRuns.length + srvErrors.length;
  if(total){ badge.style.display='inline-block'; badge.textContent=total; } else { badge.style.display='none'; }

  // Server (backend) errors
  const slist = document.getElementById('srv-err-list'); slist.innerHTML='';
  if(!srvErrors.length){ slist.appendChild(el('div','empty','No server errors recorded. 🎉')); }
  srvErrors.forEach(e => {
    const box = el('div','err');
    const top = el('div','err-top');
    top.appendChild(el('span','pill p-failed', e.kind || 'Error'));
    top.appendChild(el('span',null,e.at));
    if(e.method||e.path){ top.appendChild(el('span','mono', ((e.method||'')+' '+(e.path||'')).trim())); }
    box.appendChild(top);
    if(e.message){ const m=el('div','err-msgs'); m.textContent=e.message; box.appendChild(m); }
    if(e.detail){ const d=el('details'); const sm=el('summary',null,'traceback'); sm.style.cursor='pointer'; sm.style.fontSize='11px'; sm.style.color='var(--mut)'; d.appendChild(sm); const pre=el('pre'); pre.textContent=e.detail; pre.style.cssText='white-space:pre-wrap;font-size:11px;color:var(--ink-2);margin:6px 0 0;overflow:auto'; d.appendChild(pre); box.appendChild(d); }
    slist.appendChild(box);
  });

  // Coding-run errors
  list.innerHTML='';
  if(!errRuns.length){ list.appendChild(el('div','empty','No coding-run errors recorded. 🎉')); return; }
  errRuns.forEach(r => {
    const box = el('div','err');
    const top = el('div','err-top');
    top.appendChild(pill(r.status));
    top.appendChild(el('span',null,r.at));
    top.appendChild(el('span','mono',r.session||'—'));
    top.appendChild(el('span',null,(r.models||[]).join(', ')||'—'));
    top.appendChild(el('span',null,(r.error_count||0)+' error'+((r.error_count||0)===1?'':'s')));
    box.appendChild(top);
    const msgs = r.error_sample || [];
    if(msgs.length){ const ul=el('ul','err-msgs'); msgs.forEach(m=>ul.appendChild(el('li',null,m))); box.appendChild(ul); }
    else { box.appendChild(el('div','muted','(no message captured — run predates message capture)')); }
    list.appendChild(box);
  });
}
renderErrors();

// ---- messages ----
let msgFilter = 'all';
document.querySelectorAll('#view-messages .filter button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#view-messages .filter button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); msgFilter = b.dataset.filter; renderMessages();
}));
function updateBadge(){
  const n = MSGS.filter(m => m.status==='unresolved').length;
  const b = document.getElementById('msg-badge');
  if(n>0){ b.style.display='inline-block'; b.textContent = n; } else { b.style.display='none'; }
}
async function toggleStatus(m, btn){
  const next = m.status==='resolved' ? 'unresolved' : 'resolved';
  btn.disabled = true;
  try {
    const res = await fetch('/admin/messages/' + encodeURIComponent(m.id) + '/status',
      { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status: next}) });
    if(!res.ok) throw new Error('failed');
    m.status = next; renderMessages(); updateBadge();
  } catch(e){ alert('Could not update status.'); btn.disabled=false; }
}
function renderMessages(){
  const list = document.getElementById('msg-list'); list.innerHTML = '';
  const items = MSGS.filter(m => msgFilter==='all' || m.status===msgFilter);
  if(!items.length){ list.appendChild(el('div','empty','No messages.')); return; }
  items.forEach(m => {
    const box = el('div','msg');
    const top = el('div','msg-top');
    const who = el('div','msg-who');
    who.appendChild(el('span','msg-name', m.name || 'Anonymous'));
    who.appendChild(el('span','msg-email', m.email || ''));
    const meta = el('div','msg-meta');
    meta.appendChild(el('span', 'st st-' + m.status, m.status));
    meta.appendChild(el('span','msg-when', m.at || ''));
    top.appendChild(who); top.appendChild(meta); box.appendChild(top);
    if(m.title){ box.appendChild(el('div','msg-title', m.title)); }
    box.appendChild(el('div','msg-body', m.body || ''));
    const actions = el('div','msg-actions');
    const reply = el('a','btn btn-p','↩ Reply by email');
    reply.href = 'mailto:' + encodeURIComponent(m.email) + '?subject=' + encodeURIComponent('Re: ' + (m.title || 'Your message to CAT'));
    actions.appendChild(reply);
    const tog = el('button','btn', m.status==='resolved' ? 'Mark unresolved' : 'Mark resolved');
    tog.addEventListener('click', () => toggleStatus(m, tog));
    actions.appendChild(tog); box.appendChild(actions);
    list.appendChild(box);
  });
}
renderMessages(); updateBadge();
</script>
</body></html>"""
