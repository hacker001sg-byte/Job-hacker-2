// Job Hacker frontend — no build step, plain ES modules.

const STAGES = [
  { id: "saved", label: "Saved" },
  { id: "applied", label: "Applied" },
  { id: "interviewing", label: "Interviewing" },
  { id: "offer", label: "Offer" },
  { id: "closed", label: "Closed" },
];
const STAGE = Object.fromEntries(STAGES.map((s) => [s.id, s]));
const stageColor = (id) => `var(--st-${id})`;

const state = {
  session: null,
  jobs: null,
  filter: localGet("jh.filter") || "active",
  sort: localGet("jh.sort") || "updated",
  q: "",
};

const $main = document.getElementById("main");

// ---------- utilities ----------

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function html(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    let v = vals[i - 1];
    const isRaw = (x) => x !== null && typeof x === "object" && "__raw" in x;
    if (isRaw(v)) v = v.__raw;
    else if (Array.isArray(v)) v = v.map((x) => isRaw(x) ? x.__raw : esc(x)).join("");
    else v = esc(v);
    return out + v + s;
  });
}
const raw = (s) => ({ __raw: s });

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", headers: {}, ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch("/api" + path, init);
  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) data = await res.json();
  if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/session")) {
    state.session = { ...(state.session || {}), logged_in: false };
    renderLogin();
    throw new Error("Log in to continue.");
  }
  if (!res.ok) {
    const err = new Error((data && (data.detail || data.reason)) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = kind), kind === "error" ? 5000 : 2600);
}

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return "now";
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  if (d < 60) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}
function longDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
}
function fitColor(n) { return n >= 7 ? "var(--fit-high)" : n >= 5 ? "var(--fit-mid)" : "var(--fit-low)"; }

function busy(btn, label) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(label)}</span>`;
  return () => { btn.disabled = false; btn.innerHTML = old; };
}

// Full-screen "working" card for AI calls, so a slow request never looks like a crash.
// Shows a spinning donut, what's happening, a typical duration and a live timer.
function aiWait(title, detail, typical) {
  const el = document.createElement("div");
  el.className = "aiwait";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = html`
    <div class="aiwait-card">
      <svg class="donut" viewBox="0 0 80 80" aria-hidden="true">
        <circle class="donut-track" cx="40" cy="40" r="32"/>
        <circle class="donut-arc" cx="40" cy="40" r="32"/>
      </svg>
      <h2>${title}</h2>
      <p class="aiwait-detail">${detail}</p>
      <p class="aiwait-time"><span id="aw-clock">0:00</span><span class="aiwait-typ">${typical ? ` · usually ${typical}` : ""}</span></p>
      <p class="aiwait-slow" hidden>Taking longer than usual. Still waiting for Claude, so keep this open.</p>
    </div>`;
  document.body.append(el);
  document.body.classList.add("waiting");
  const t0 = Date.now();
  const clock = el.querySelector("#aw-clock");
  const slow = el.querySelector(".aiwait-slow");
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (s >= 90) slow.hidden = false;
  }, 250);
  requestAnimationFrame(() => el.classList.add("show"));
  return () => {
    clearInterval(timer);
    document.body.classList.remove("waiting");
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  };
}

// Run an AI request with the waiting card up; always takes it down again.
async function withAI(opts, fn) {
  const stop = aiWait(opts.title, opts.detail, opts.typical);
  try { return await fn(); } finally { stop(); }
}

function setView(markup) {
  $main.innerHTML = markup;
  $main.firstElementChild?.classList.add("view-enter");
  window.scrollTo(0, 0);
}

const icon = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

// ---------- routing ----------

function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(qs || "") };
}

async function route() {
  if (!state.session) await loadSession();
  if (state.session.auth_required && !state.session.logged_in) return renderLogin();
  const { parts, params } = parseHash();
  document.querySelectorAll("[data-nav]").forEach((a) => a.removeAttribute("aria-current"));
  try {
    if (parts[0] === "job" && parts[1]) return await renderJob(Number(parts[1]));
    if (parts[0] === "add") { markNav("add"); return renderAdd(params); }
    if (parts[0] === "settings") { markNav("settings"); return await renderSettings(); }
    return await renderList();
  } catch (e) {
    if (e.status === 401) return;
    setView(html`<div class="empty"><h2>Something went wrong</h2><p>${e.message}</p><a class="btn" href="#/">Back to jobs</a></div>`);
  }
}
function markNav(n) { document.querySelector(`[data-nav=${n}]`)?.setAttribute("aria-current", "page"); }

async function loadSession() {
  state.session = await api("/session");
}

// ---------- login ----------

function renderLogin() {
  setView(html`
    <form class="login" id="login">
      <h1>Welcome back</h1>
      <p>Enter the password you set for this app.</p>
      <div class="field">
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="current-password" required autofocus>
      </div>
      <button class="btn btn-primary btn-wide" type="submit">Log in</button>
      <p class="hint" id="login-err" role="alert"></p>
    </form>`);
  document.getElementById("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const done = busy(btn, "Logging in");
    try {
      await api("/login", { json: { password: document.getElementById("pw").value } });
      state.session = null;
      route();
    } catch (err) {
      document.getElementById("login-err").textContent = err.message;
      done();
    }
  });
}

// ---------- list ----------

async function renderList() {
  if (!state.jobs) {
    setView('<p class="hint">Loading your jobs…</p>');
    state.jobs = await api("/jobs");
  }
  const jobs = state.jobs;
  const counts = Object.fromEntries(STAGES.map((s) => [s.id, 0]));
  jobs.forEach((j) => counts[j.status] = (counts[j.status] || 0) + 1);
  const active = jobs.length - counts.closed;

  setView(html`
    <div>
      <form class="quickadd" id="quickadd" autocomplete="off">
        <input type="url" inputmode="url" name="url" placeholder="Paste a job link" aria-label="Job link" required>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>

      ${jobs.length ? raw(html`
      <section class="flow ${state.filter !== "all" && state.filter !== "active" ? "filtered" : ""}" aria-label="Pipeline">
        <div class="flow-bar">
          ${STAGES.filter((s) => counts[s.id]).map((s) => raw(html`<button class="flow-seg ${state.filter === s.id ? "on" : ""}" data-st="${s.id}" data-filter="${s.id}" style="--n:${counts[s.id]};--c:${raw(stageColor(s.id))}" aria-label="${s.label}: ${counts[s.id]}"></button>`))}
        </div>
        <div class="flow-legend" role="group" aria-label="Filter by stage">
          <button class="stage" data-filter="active" aria-pressed="${state.filter === "active"}">Active <span class="n">${active}</span></button>
          ${STAGES.map((s) => raw(html`<button class="stage" data-filter="${s.id}" aria-pressed="${state.filter === s.id}" style="--c:${raw(stageColor(s.id))}"><span class="dot"></span>${s.label} <span class="n">${counts[s.id]}</span></button>`))}
          <button class="stage" data-filter="all" aria-pressed="${state.filter === "all"}">All <span class="n">${jobs.length}</span></button>
        </div>
      </section>
      <div class="searchrow">
        <input type="search" id="q" placeholder="Search title, company, notes" value="${state.q}" aria-label="Search jobs">
        <select id="sort" aria-label="Sort">
          <option value="updated" ${state.sort === "updated" ? "selected" : ""}>Recent</option>
          <option value="fit" ${state.sort === "fit" ? "selected" : ""}>Best fit</option>
          <option value="company" ${state.sort === "company" ? "selected" : ""}>Company</option>
        </select>
      </div>
      <ul class="jobs" id="jobs"></ul>`) : raw(html`
      <div class="empty">
        <h2>Your pipeline is empty</h2>
        <p>Paste a link to a job posting above. LinkedIn, MyCareersFuture, company career pages and most job boards work. If a site won't share its details, you can paste the post's text instead.</p>
        <p>Moving from the old tracker? Import your backup in <a href="#/settings">Settings</a>.</p>
      </div>`)}
    </div>`);

  document.getElementById("quickadd").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    if (url) location.hash = "#/add?url=" + encodeURIComponent(url);
  });
  if (!jobs.length) return;
  $main.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    localSet("jh.filter", state.filter);
    renderList();
  }));
  const q = document.getElementById("q");
  q.addEventListener("input", () => { state.q = q.value; drawRows(); });
  document.getElementById("sort").addEventListener("change", (e) => {
    state.sort = e.target.value; localSet("jh.sort", state.sort); drawRows();
  });
  drawRows();
}

function drawRows() {
  const needle = state.q.trim().toLowerCase();
  let rows = state.jobs.filter((j) => {
    if (state.filter === "active" && j.status === "closed") return false;
    if (!["all", "active"].includes(state.filter) && j.status !== state.filter) return false;
    if (needle && !`${j.title} ${j.company} ${j.location} ${j.tags}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  if (state.sort === "fit") rows.sort((a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1));
  else if (state.sort === "company") rows.sort((a, b) => (a.company || "").localeCompare(b.company || ""));
  const ul = document.getElementById("jobs");
  if (!rows.length) {
    ul.innerHTML = html`<li class="empty"><p>No jobs match. ${state.filter !== "all" ? "Try the All filter." : ""}</p></li>`;
    return;
  }
  ul.innerHTML = rows.map((j) => html`
    <li><a class="job" href="#/job/${j.id}">
      <span class="job-bar" style="--c:${raw(stageColor(j.status))}" title="${STAGE[j.status]?.label}"></span>
      <span>
        <span class="job-title">${j.title}</span>
        <span class="job-sub" style="display:block">${[j.company, j.location].filter(Boolean).join(", ") || "Company not set"}${j.has_description ? "" : raw(' <span class="warn">— no description yet</span>')}</span>
      </span>
      <span class="job-side">
        ${j.fit_score ? raw(html`<span class="fit" style="--fc:${raw(fitColor(j.fit_score))}" aria-label="Fit ${j.fit_score} out of 10">${j.fit_score}</span>`) : ""}
        <span class="age" aria-label="Updated">${ago(j.updated_at)}</span>
      </span>
    </a></li>`).join("");
}

// ---------- add ----------

const EMPTY = { title: "", company: "", location: "", salary: "", employment_type: "", posted_date: "", description: "", url: "" };

function renderAdd(params) {
  const url = params.get("url") || "";
  const mode = params.get("mode") || (url ? "link" : "link");
  setView(html`
    <div>
      <a class="btn btn-ghost back" href="#/">${raw(icon.back)}Jobs</a>
      <h1>Add a job</h1>
      <div class="tabs" role="tablist" aria-label="How to add">
        <button role="tab" data-mode="link" aria-selected="${mode === "link"}">Link</button>
        <button role="tab" data-mode="paste" aria-selected="${mode === "paste"}">Paste</button>
        <button role="tab" data-mode="manual" aria-selected="${mode === "manual"}">Manual</button>
        <button role="tab" data-mode="bulk" aria-selected="${mode === "bulk"}">Bulk</button>
      </div>
      <div id="add-body"></div>
    </div>`);
  $main.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    $main.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-selected", x === b));
    showMode(b.dataset.mode, { url: document.querySelector("#add-body [name=url]")?.value || url });
  }));
  showMode(mode, { url, auto: !!url });
}

function selectTab(mode) {
  $main.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-selected", x.dataset.mode === mode));
}

function showMode(mode, { url = "", auto = false, note = "" } = {}) {
  const body = document.getElementById("add-body");
  selectTab(mode);
  if (mode === "link") {
    body.innerHTML = html`
      <form id="f-link">
        <div class="field">
          <label for="u">Job link</label>
          <input id="u" name="url" type="url" inputmode="url" placeholder="https://…" value="${url}" required>
          <p class="hint">Works with LinkedIn, MyCareersFuture, JobStreet, Indeed and most company career pages.</p>
        </div>
        <button class="btn btn-primary btn-wide" type="submit">Get job details</button>
      </form>`;
    const form = document.getElementById("f-link");
    form.addEventListener("submit", (e) => { e.preventDefault(); fetchLink(form.url.value.trim(), e.submitter); });
    if (auto && url) fetchLink(url, form.querySelector("button"));
    else form.url.focus();
  } else if (mode === "paste") {
    body.innerHTML = html`
      ${note ? raw(html`<div class="callout"><p>${note}</p><p>Open the posting, select all the text, copy it, and paste it below.</p></div>`) : ""}
      <form id="f-paste">
        <div class="field">
          <label for="t">Job post</label>
          <textarea id="t" name="text" class="tall" placeholder="Paste everything from the posting: title, company, description…" required></textarea>
        </div>
        <div class="field">
          <label for="pu">Link to the posting <span class="hint" style="display:inline">(optional)</span></label>
          <input id="pu" name="url" type="url" inputmode="url" value="${url}">
        </div>
        <button class="btn btn-primary btn-wide" type="submit">${state.session.ai_enabled ? "Fill in the details" : "Continue"}</button>
        ${state.session.ai_enabled ? "" : raw('<p class="hint">AI is off, so you\'ll fill in title and company yourself on the next step.</p>')}
      </form>`;
    const form = document.getElementById("f-paste");
    form.text.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const done = busy(e.submitter, "Reading the post");
      try {
        const r = state.session.ai_enabled
          ? await withAI({ title: "Reading the job post", detail: "Claude is picking out the title, company, salary and description from your paste.", typical: "10–30 seconds" },
              () => api("/extract/text", { json: { text: form.text.value, url: form.url.value } }))
          : await api("/extract/text", { json: { text: form.text.value, url: form.url.value } });
        showReview(r.draft, r.method === "AI" ? "Filled in by AI from your paste. Check it over." : (r.note || "Fill in the title and company."));
      } catch (err) { toast(err.message, "error"); done(); }
    });
  } else if (mode === "bulk") {
    renderBulk(body);
  } else {
    showReview({ ...EMPTY, url }, "");
  }
}

// ---------- bulk add ----------

let bulkCancel = false;

function findLinks(text) {
  const out = [];
  for (const tok of (text || "").split(/[\s,;<>"'()]+/)) {
    let t = tok.trim().replace(/[.)\]]+$/, "");
    if (!t) continue;
    if (/^www\./i.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S/i.test(t)) t = "https://" + t;
    if (/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

async function renderBulk(body) {
  if (!state.jobs) state.jobs = await api("/jobs");
  const missing = state.jobs.filter((j) => j.url && !j.has_description);
  body.innerHTML = html`
    <section class="bulk">
      <h2>Paste many links</h2>
      <p class="hint">One per line, or paste any text with links in it. Each one is read and saved, and links you've already saved are skipped.</p>
      <div class="field" style="margin-top:12px">
        <label for="bulk-links" class="sr">Job links</label>
        <textarea id="bulk-links" class="tall" placeholder="https://www.linkedin.com/jobs/view/…&#10;https://www.mycareersfuture.gov.sg/job/…"></textarea>
        <p class="hint" id="bulk-count">No links yet.</p>
      </div>
      <div class="actions"><button class="btn btn-primary" id="bulk-go" disabled>Save all links</button></div>
      <div id="bulk-out"></div>

      <h2>Fill in missing details</h2>
      ${missing.length
        ? raw(html`<p class="hint">${missing.length} saved job${missing.length === 1 ? " has" : "s have"} a link but no description, usually from a CSV import. Each one is read from its link; nothing you've already filled in is changed.</p>
          <div class="actions"><button class="btn" id="fill-go">Fill in ${missing.length} job${missing.length === 1 ? "" : "s"}</button></div>`)
        : raw('<p class="hint">Every saved job with a link already has a description.</p>')}
      <div id="fill-out"></div>

      <h2>Import a CSV</h2>
      <p class="hint">The same format as the old tracker: <code>Job URL</code>, <code>Job title</code>, <code>Company Name</code>, <code>Location</code>, <code>Published At</code>, <code>Status</code>. Only <code>Job title</code> is required.</p>
      <div class="actions"><label class="btn" style="margin:0">Choose CSV file<input type="file" id="bulk-csv" accept=".csv,text/csv" hidden></label></div>
    </section>`;

  const ta = document.getElementById("bulk-links");
  const go = document.getElementById("bulk-go");
  const count = document.getElementById("bulk-count");
  ta.addEventListener("input", () => {
    const n = findLinks(ta.value).length;
    count.textContent = n ? `${n} link${n === 1 ? "" : "s"} found.` : "No links yet.";
    go.disabled = !n;
  });
  go.addEventListener("click", () => {
    const links = findLinks(ta.value);
    runBatch({
      items: links, out: document.getElementById("bulk-out"), btn: go, verb: "Saving",
      label: (u) => u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60),
      call: (u) => api("/jobs/from-url", { json: { url: u } }),
      done: (failed) => {
        ta.value = failed.join("\n");
        ta.dispatchEvent(new Event("input"));
        if (failed.length) count.textContent = `${failed.length} link${failed.length === 1 ? "" : "s"} couldn't be read and ${failed.length === 1 ? "is" : "are"} left above.`;
      },
    });
  });

  document.getElementById("fill-go")?.addEventListener("click", (e) => {
    runBatch({
      items: missing, out: document.getElementById("fill-out"), btn: e.currentTarget, verb: "Filling in",
      label: (j) => [j.title, j.company].filter(Boolean).join(", "),
      call: (j) => api(`/jobs/${j.id}/refresh`, { method: "POST" }).then((r) => ({ ...r, job: r.job || j, url: j.url })),
    });
  });

  const csv = document.getElementById("bulk-csv");
  csv.addEventListener("change", async () => {
    const file = csv.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api("/import/csv", { method: "POST", body: fd });
      toast(`Imported ${r.added} job${r.added === 1 ? "" : "s"}${r.duplicates ? `, skipped ${r.duplicates} already saved` : ""}`);
      state.jobs = null;
      renderBulk(body);
    } catch (err) { toast(err.message, "error"); }
    csv.value = "";
  });
}

const RESULT = {
  added: { cls: "ok", text: "Saved" },
  updated: { cls: "ok", text: "Filled in" },
  duplicate: { cls: "skip", text: "Already saved" },
  unchanged: { cls: "skip", text: "Nothing new found" },
  failed: { cls: "fail", text: "Couldn't read it" },
};

async function runBatch({ items, out, btn, verb, label, call, done }) {
  bulkCancel = false;
  btn.disabled = true;
  out.innerHTML = html`
    <div class="batch">
      <div class="batch-head"><strong id="b-status">${verb} 0 of ${items.length}</strong><button class="btn btn-ghost" id="b-stop">Stop</button></div>
      <div class="batch-bar"><span id="b-bar"></span></div>
      <ul class="batch-list" id="b-list"></ul>
    </div>`;
  const list = out.querySelector("#b-list");
  const status = out.querySelector("#b-status");
  const bar = out.querySelector("#b-bar");
  out.querySelector("#b-stop").addEventListener("click", (e) => { bulkCancel = true; e.target.disabled = true; e.target.textContent = "Stopping…"; });
  const tally = { ok: 0, skip: 0, fail: 0 };
  const failed = [];
  let i = 0;
  for (const item of items) {
    if (bulkCancel) break;
    const li = document.createElement("li");
    li.className = "busy";
    li.innerHTML = html`<span class="b-dot"></span><span class="b-main"><span class="b-title">${label(item)}</span><span class="b-note">Reading…</span></span>`;
    list.prepend(li);
    let r;
    try { r = await call(item); } catch (e) { r = { status: "failed", reason: e.message, url: typeof item === "string" ? item : item.url }; }
    const res = RESULT[r.status] || RESULT.failed;
    tally[res.cls]++;
    if (res.cls === "fail") failed.push(typeof item === "string" ? item : item.url);
    li.className = res.cls;
    const j = r.job;
    const title = j ? [j.title, j.company].filter(Boolean).join(", ") : label(item);
    let note = res.text;
    if (r.status === "updated") note += `: ${r.filled.map((f) => f.replace("_", " ")).join(", ")}`;
    if (r.status === "failed") note += `. ${r.reason || ""}`;
    const fix = r.status === "failed"
      ? (j ? html` <a href="#/job/${j.id}">Open it</a>` : html` <a href="#/add?mode=paste&url=${encodeURIComponent(r.url || "")}">Paste text instead</a>`)
      : "";
    li.innerHTML = html`<span class="b-dot"></span><span class="b-main">${j ? raw(html`<a class="b-title" href="#/job/${j.id}">${title}</a>`) : raw(html`<span class="b-title">${title}</span>`)}<span class="b-note">${note}${raw(fix)}</span></span>`;
    i++;
    status.textContent = `${verb} ${i} of ${items.length}`;
    bar.style.width = `${(i / items.length) * 100}%`;
    if (i < items.length) await new Promise((res2) => setTimeout(res2, 600)); // be gentle with job sites
  }
  state.jobs = null;
  const parts = [];
  if (tally.ok) parts.push(`${tally.ok} ${verb === "Saving" ? "saved" : "filled in"}`);
  if (tally.skip) parts.push(`${tally.skip} skipped`);
  if (tally.fail) parts.push(`${tally.fail} couldn't be read`);
  status.textContent = (bulkCancel ? "Stopped. " : "Done. ") + (parts.join(", ") || "Nothing to do") + ".";
  out.querySelector("#b-stop").remove();
  btn.disabled = false;
  if (tally.fail) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "For the ones that couldn't be read, use “Paste text instead” and paste the post yourself.";
    out.querySelector(".batch").append(p);
  }
  if (!bulkCancel || i) done?.(bulkCancel ? [...failed, ...items.slice(i)] : failed);
}

async function fetchLink(url, btn) {
  if (!url) return;
  const done = busy(btn, "Reading the page");
  try {
    const r = await withAI({ title: "Reading the job page", detail: state.session.ai_enabled
        ? "Opening the link and looking for the job details. If the page doesn't list them clearly, Claude reads it."
        : "Opening the link and looking for the job details.", typical: "5–30 seconds" },
      () => api("/extract/url", { json: { url } }));
    if (r.existing_id) {
      document.getElementById("add-body").innerHTML = html`
        <div class="callout info"><p><strong>Already saved.</strong> ${r.title}${r.company ? ` at ${r.company}` : ""} is in your list.</p></div>
        <a class="btn btn-primary" href="#/job/${r.existing_id}">Open it</a>`;
      return;
    }
    showReview(r.draft, `Found via ${r.method}. Check it over, then save.`);
  } catch (err) {
    if (err.data?.needs_manual) {
      showMode("paste", { url: err.data.url || url, note: err.data.reason });
    } else { toast(err.message, "error"); done(); }
  }
}

function jobForm(d, submitLabel) {
  return html`
    <form id="f-job">
      <div class="field"><label for="jt">Job title</label><input id="jt" name="title" type="text" value="${d.title}" required></div>
      <div class="grid2">
        <div class="field"><label for="jc">Company</label><input id="jc" name="company" type="text" value="${d.company}"></div>
        <div class="field"><label for="jl">Location</label><input id="jl" name="location" type="text" value="${d.location}"></div>
        <div class="field"><label for="js">Salary</label><input id="js" name="salary" type="text" value="${d.salary}"></div>
        <div class="field"><label for="je">Job type</label><input id="je" name="employment_type" type="text" value="${d.employment_type}" placeholder="Full time, contract…"></div>
        <div class="field"><label for="jp">Posted</label><input id="jp" name="posted_date" type="text" value="${d.posted_date}"></div>
        <div class="field"><label for="ju">Link</label><input id="ju" name="url" type="url" inputmode="url" value="${d.url || ""}"></div>
      </div>
      <div class="field">
        <label for="jd">Description</label>
        <textarea id="jd" name="description" class="tall" placeholder="Paste the job description here. It's what the fit check and tailored resume work from.">${d.description}</textarea>
      </div>
      <div class="sticky-actions"><button class="btn btn-primary btn-wide" type="submit">${submitLabel}</button></div>
    </form>`;
}

function formData(form) {
  const out = {};
  ["title", "company", "location", "salary", "employment_type", "posted_date", "url", "description"].forEach((k) => out[k] = form[k].value.trim());
  return out;
}

function showReview(draft, note) {
  const body = document.getElementById("add-body");
  body.innerHTML = (note ? html`<p class="method">${note}</p>` : "") + jobForm({ ...EMPTY, ...draft }, "Save job");
  const form = document.getElementById("f-job");
  if (!draft.title) form.title.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const done = busy(e.submitter, "Saving");
    try {
      const j = await api("/jobs", { json: { ...formData(form), source: draft.source || "app" } });
      state.jobs = null;
      toast(j.duplicate ? "Already saved, details filled in" : "Saved");
      location.hash = `#/job/${j.id}`;
    } catch (err) { toast(err.message, "error"); done(); }
  });
}

// ---------- job detail ----------

async function renderJob(id) {
  const j = await api(`/jobs/${id}`);
  const personas = state.session.ai_enabled ? await api("/personas") : [];
  const facts = [["Location", j.location], ["Salary", j.salary], ["Job type", j.employment_type], ["Posted", j.posted_date], ["Saved", longDate(j.created_at)]].filter(([, v]) => v);
  const desc = j.description || "";

  setView(html`
    <article>
      <a class="btn btn-ghost back" href="#/">${raw(icon.back)}Jobs</a>
      <header class="detail-head">
        <h1>${j.title}</h1>
        ${j.company ? raw(html`<div class="company">${j.company}</div>`) : ""}
        <dl class="facts">${facts.map(([k, v]) => raw(html`<div><dt>${k}</dt><dd>${v}</dd></div>`))}</dl>
        <div class="row">
          ${j.url ? raw(html`<a class="btn" href="${j.url}" target="_blank" rel="noopener">Open posting ${raw(icon.ext)}</a>`) : ""}
          <button class="btn" id="edit">Edit details</button>
        </div>
      </header>

      <section class="section" aria-labelledby="h-stage">
        <h2 id="h-stage">Stage</h2>
        <div class="stages-pick" role="group" aria-labelledby="h-stage">
          ${STAGES.map((s) => raw(html`<button data-st="${s.id}" aria-pressed="${j.status === s.id}" style="--c:${raw(stageColor(s.id))}">${s.label}</button>`))}
        </div>
        ${j.applied_at ? raw(html`<p class="applied-note">Applied ${longDate(j.applied_at)}, ${ago(j.applied_at) === "now" ? "today" : ago(j.applied_at) + " ago"}.</p>`) : ""}
      </section>

      ${state.session.ai_enabled ? raw(html`
      <section class="section" aria-labelledby="h-fit">
        <h2 id="h-fit">Fit</h2>
        <div id="fit"></div>
      </section>

      <section class="section" aria-labelledby="h-docs">
        <h2 id="h-docs">Resume and cover letter</h2>
        <div class="panel">
          ${personas.length > 1 ? raw(html`<div class="field"><label for="persona">Base resume</label><select id="persona">${personas.map((p) => raw(html`<option value="${p.id}" ${p.is_default ? "selected" : ""}>${p.name}</option>`))}</select></div>`) : ""}
          ${!personas.length || !personas.some((p) => p.resume_text.trim()) ? raw('<div class="callout"><p>Add your base resume in <a href="#/settings">Settings</a> to tailor documents.</p></div>') : ""}
          <div class="field">
            <label for="instr">Anything to emphasise? <span class="hint" style="display:inline">(optional)</span></label>
            <input id="instr" type="text" placeholder="e.g. lead with my Citibank transformation work">
          </div>
          <div class="row">
            <button class="btn btn-primary" data-gen="resume">Tailor my resume</button>
            <button class="btn" data-gen="cover_letter">Write a cover letter</button>
          </div>
        </div>
        <div id="docs" style="margin-top:14px"></div>
      </section>`) : ""}

      <section class="section" aria-labelledby="h-notes">
        <h2 id="h-notes">Notes</h2>
        <textarea id="notes" placeholder="Recruiter name, interview dates, follow-ups…">${j.notes || ""}</textarea>
        <p class="hint" id="notes-state">Saves when you leave the box.</p>
      </section>

      <section class="section" aria-labelledby="h-desc">
        <h2 id="h-desc">Job description</h2>
        ${desc ? raw(html`<div class="prose ${desc.length > 1400 ? "clamped" : ""}" id="desc">${desc}</div>
          ${desc.length > 1400 ? raw('<button class="btn btn-ghost" id="more">Show the full description</button>') : ""}`)
          : raw('<div class="callout"><p>No description saved yet. Use <strong>Edit details</strong> to paste it in, so the fit check and tailoring have something to work from.</p></div>')}
      </section>

      <section class="section">
        <button class="btn btn-danger" id="del">Delete this job</button>
      </section>
    </article>`);

  $main.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", async () => {
    if (b.getAttribute("aria-pressed") === "true") return;
    try {
      await api(`/jobs/${id}`, { method: "PATCH", json: { status: b.dataset.st } });
      state.jobs = null;
      toast(`Moved to ${STAGE[b.dataset.st].label}`);
      renderJob(id);
    } catch (e) { toast(e.message, "error"); }
  }));

  document.getElementById("edit").addEventListener("click", () => renderEdit(j));
  document.getElementById("more")?.addEventListener("click", (e) => {
    document.getElementById("desc").classList.remove("clamped"); e.target.remove();
  });

  const notes = document.getElementById("notes");
  notes.addEventListener("change", async () => {
    const st = document.getElementById("notes-state");
    try { await api(`/jobs/${id}`, { method: "PATCH", json: { notes: notes.value } }); st.textContent = "Notes saved."; }
    catch (e) { st.textContent = e.message; }
  });

  document.getElementById("del").addEventListener("click", async () => {
    if (!confirm(`Delete “${j.title}”? Its resume and cover letters go too.`)) return;
    await api(`/jobs/${id}`, { method: "DELETE" });
    state.jobs = null;
    toast("Deleted");
    location.hash = "#/";
  });

  if (state.session.ai_enabled) {
    drawFit(j);
    drawDocs(j.documents);
    $main.querySelectorAll("[data-gen]").forEach((b) => b.addEventListener("click", async () => {
      const kind = b.dataset.gen;
      const done = busy(b, kind === "resume" ? "Tailoring" : "Writing");
      try {
        const doc = await withAI(kind === "resume"
          ? { title: "Tailoring your resume", detail: `Claude is matching your resume to ${j.title}${j.company ? ` at ${j.company}` : ""} and rewriting the summary and bullets.`, typical: "30–90 seconds" }
          : { title: "Writing your cover letter", detail: `Claude is writing a letter for ${j.title}${j.company ? ` at ${j.company}` : ""} from your resume.`, typical: "15–45 seconds" },
          () => api(`/jobs/${id}/documents`, { json: {
            kind, persona_id: Number(document.getElementById("persona")?.value) || null,
            instructions: document.getElementById("instr").value,
          } }));
        j.documents.unshift(doc);
        drawDocs(j.documents, doc.id);
        toast(kind === "resume" ? "Resume ready" : "Cover letter ready");
      } catch (e) { toast(e.message, "error"); }
      done();
    }));
  }
}

function drawFit(j) {
  const box = document.getElementById("fit");
  const f = j.fit;
  if (!f) {
    box.innerHTML = html`<div class="panel"><p>Get a 1 to 10 score against your resume and what you're looking for, with strengths, gaps and keywords to use.</p><button class="btn btn-primary" id="dofit">Check my fit</button></div>`;
  } else {
    box.innerHTML = html`
      <div class="panel fitbox">
        <span class="fit big" style="--fc:${raw(fitColor(f.score))}" aria-label="Fit ${f.score} out of 10">${f.score}</span>
        <div><p class="verdict">${f.verdict}</p><button class="btn btn-ghost" id="dofit" style="margin-left:-10px">Check again</button></div>
        <div class="fitlists">
          <div><h3>Strengths</h3><ul>${(f.strengths || []).map((s) => raw(html`<li>${s}</li>`))}</ul></div>
          <div><h3>Gaps</h3><ul>${(f.gaps || []).map((s) => raw(html`<li>${s}</li>`))}</ul></div>
        </div>
        ${f.keywords?.length ? raw(html`<div class="kw" aria-label="Keywords to mirror">${f.keywords.map((k) => raw(html`<span>${k}</span>`))}</div>`) : ""}
      </div>`;
  }
  document.getElementById("dofit").addEventListener("click", async (e) => {
    const done = busy(e.currentTarget, "Checking");
    try {
      const nj = await withAI({ title: "Checking your fit", detail: "Claude is comparing the job with your resume and what you're looking for.", typical: "10–30 seconds" },
        () => api(`/jobs/${j.id}/fit`, { method: "POST" }));
      state.jobs = null;
      drawFit(nj);
    } catch (err) { toast(err.message, "error"); done(); }
  });
}

// Resumes come back as light Markdown (#, ##, ###, "- ", **bold**).
const isMd = (t) => /^#{1,3}\s/m.test(t || "");
function inline(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); }
function mdToHtml(md) {
  const out = [];
  let list = false, head = 0;
  const close = () => { if (list) { out.push("</ul>"); list = false; } };
  for (const raw of md.split("\n")) {
    const l = raw.trimEnd();
    if (!l.trim()) { close(); continue; }
    let m;
    if ((m = l.match(/^# (.*)/))) { close(); out.push(`<h3 class="r-name">${inline(m[1])}</h3>`); head = 1; }
    else if ((m = l.match(/^## (.*)/))) { close(); head = 0; out.push(`<h4 class="r-sec">${inline(m[1])}</h4>`); }
    else if ((m = l.match(/^### (.*)/))) {
      close();
      const i = m[1].lastIndexOf(" | ");
      out.push(i > 0 ? `<p class="r-role"><strong>${inline(m[1].slice(0, i))}</strong><span>${inline(m[1].slice(i + 3))}</span></p>` : `<p class="r-role"><strong>${inline(m[1])}</strong></p>`);
    }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (head && head < 3) { out.push(`<p class="r-head${head === 1 ? " r-contact" : ""}">${inline(l)}</p>`); head++; }
    else if (/^\*\*.+\*\*$/.test(l.trim())) { close(); out.push(`<p class="r-title">${esc(l.trim().replace(/^\*\*|\*\*$/g, ""))}</p>`); }
    else { close(); out.push(`<p>${inline(l)}</p>`); }
  }
  close();
  return out.join("");
}
function toPlain(md) {
  return md.split("\n").map((l) => {
    if (l.startsWith("# ")) return l.slice(2);
    if (l.startsWith("## ")) return "\n" + l.slice(3).toUpperCase();
    if (l.startsWith("### ")) return "\n" + l.slice(4);
    if (/^\s*[-*]\s+/.test(l)) return "• " + l.replace(/^\s*[-*]\s+/, "");
    return l;
  }).join("\n").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\n{3,}/g, "\n\n").trim();
}

function drawDocs(docs, openId) {
  const box = document.getElementById("docs");
  box.innerHTML = docs.map((d) => html`
    <details class="doc" data-doc="${d.id}" ${d.id === openId ? "open" : ""}>
      <summary><span><span class="t">${d.kind === "resume" ? "Tailored resume" : "Cover letter"}</span><br><span class="m">${longDate(d.created_at)}${d.persona_name ? `, from ${d.persona_name}` : ""}</span></span>${raw(icon.down)}</summary>
      <div class="doc-body">
        ${isMd(d.content) ? raw(html`<div class="doc-text resume-view">${raw(mdToHtml(d.content))}</div>`) : raw(html`<div class="doc-text">${d.content}</div>`)}
        <div class="row">
          <button class="btn btn-primary" data-act="copy">Copy text</button>
          <a class="btn" href="/api/documents/${d.id}/docx" download>Download Word</a>
          <button class="btn" data-act="edit">Edit</button>
          <button class="btn btn-ghost btn-danger" data-act="del">Delete</button>
        </div>
      </div>
    </details>`).join("");
  box.querySelectorAll(".doc").forEach((el) => {
    const id = Number(el.dataset.doc);
    const d = docs.find((x) => x.id === id);
    el.querySelector("[data-act=copy]").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(isMd(d.content) ? toPlain(d.content) : d.content); toast("Copied"); }
      catch { toast("Couldn't copy. Select the text and copy it instead.", "error"); }
    });
    el.querySelector("[data-act=del]").addEventListener("click", async () => {
      if (!confirm("Delete this document?")) return;
      await api(`/documents/${id}`, { method: "DELETE" });
      docs.splice(docs.indexOf(d), 1);
      drawDocs(docs);
    });
    el.querySelector("[data-act=edit]").addEventListener("click", (e) => {
      const text = el.querySelector(".doc-text");
      if (e.target.dataset.editing) {
        const val = text.querySelector("textarea").value;
        api(`/documents/${id}`, { method: "PATCH", json: { content: val } }).then(() => {
          d.content = val; toast("Saved"); drawDocs(docs, id);
        }).catch((err) => toast(err.message, "error"));
        return;
      }
      e.target.dataset.editing = "1";
      e.target.textContent = "Save changes";
      text.innerHTML = html`<textarea class="tall" aria-label="Document text">${d.content}</textarea>`;
      text.classList.remove("resume-view");
      text.style.padding = "0"; text.style.background = "none"; text.style.maxHeight = "none";
    });
  });
}

function renderEdit(j) {
  setView(html`<div>
    <button class="btn btn-ghost back" id="cancel">${raw(icon.back)}Back</button>
    <h1 style="margin-bottom:18px">Edit details</h1>
    ${raw(jobForm(j, "Save changes"))}
  </div>`);
  document.getElementById("cancel").addEventListener("click", () => renderJob(j.id));
  const form = document.getElementById("f-job");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const done = busy(e.submitter, "Saving");
    try {
      await api(`/jobs/${j.id}`, { method: "PATCH", json: formData(form) });
      state.jobs = null;
      toast("Saved");
      renderJob(j.id);
    } catch (err) { toast(err.message, "error"); done(); }
  });
}

// ---------- settings ----------

async function renderSettings() {
  await loadSession();
  const s = state.session;
  const personas = await api("/personas");
  const origin = location.origin;

  setView(html`
    <div class="settings">
      <a class="btn btn-ghost back" href="#/">${raw(icon.back)}Jobs</a>
      <h1>Settings</h1>

      <h2>Your base resume</h2>
      <p class="lead">The starting point for every tailored resume and fit check. Paste your fullest version; tailoring trims it per job.</p>
      <div class="list" id="personas">
        ${personas.map((p) => raw(html`
          <div class="list-item">
            <div><strong>${p.name}</strong>${p.is_default ? raw('<span class="badge">Default</span>') : ""}<div class="meta">${p.resume_text.trim() ? `${p.resume_text.trim().split(/\s+/).length} words` : "Empty"}</div></div>
            <button class="btn" data-persona="${p.id}">Edit</button>
          </div>`))}
      </div>
      <div class="actions"><button class="btn" id="add-persona">${personas.length ? "Add another version" : "Add your resume"}</button></div>
      <div id="persona-editor"></div>

      <h2>What you're looking for</h2>
      <p class="lead">Used by the fit check. Roles, seniority, salary floor, location, and anything that rules a job out.</p>
      <textarea id="prefs" placeholder="e.g. Senior Scrum Master or Agile Coach in Singapore. Hybrid or remote. Not NCS. Minimum S$9k a month.">${s.user.preferences || ""}</textarea>
      <div class="actions"><button class="btn btn-primary" id="save-prefs">Save</button></div>

      <h2>Profile</h2>
      <p class="lead">Each profile has its own jobs and resumes. You're using <strong>${s.user.name}</strong>.</p>
      <div class="field"><label for="pname">Profile name</label><input id="pname" type="text" value="${s.user.name}"></div>
      <div class="actions"><button class="btn" id="save-name">Rename</button></div>
      ${s.users.length > 1 ? raw(html`
        <div class="field" style="margin-top:18px"><label for="switch">Switch profile</label>
          <select id="switch">${s.users.map((u) => raw(html`<option value="${u.id}" ${u.id === s.user.id ? "selected" : ""}>${u.name}</option>`))}</select></div>`) : ""}
      <div class="actions">
        <button class="btn" id="new-user">Add a profile</button>
        ${s.users.length > 1 ? raw('<button class="btn btn-ghost btn-danger" id="del-user">Delete this profile</button>') : ""}
      </div>

      <h2>Use it from your phone</h2>
      <p class="lead">Open this site on your phone, then use <strong>Add to Home Screen</strong>. On Android, Job Hacker then appears in the share menu: share a job from LinkedIn or Chrome and it opens ready to save.</p>
      <p class="lead">On iPhone, make a Shortcut that opens <code>${origin}/?add=</code> followed by the shared URL, and turn on “Show in Share Sheet”.</p>

      <h2>Backup and import</h2>
      <p class="lead">Download everything as one file, or bring in a backup or the export from the old tracker. Jobs already saved (same link) are skipped.</p>
      <div class="actions">
        <a class="btn" href="/api/export" download>Download backup</a>
        <label class="btn" style="margin:0">Import backup<input type="file" id="imp-json" accept=".json,application/json" hidden></label>
        <label class="btn" style="margin:0">Import CSV<input type="file" id="imp-csv" accept=".csv,text/csv" hidden></label>
      </div>
      <p class="hint">CSV needs at least a <code>Job title</code> column; <code>Job URL</code>, <code>Company Name</code>, <code>Location</code>, <code>Status</code> and <code>Description</code> are used when present.</p>

      <h2>Automations</h2>
      <p class="lead">n8n or other tools can add jobs by sending a POST to <code>${origin}/api/jobs</code> with the header <code>X-API-Key</code> set to your <code>API_TOKEN</code>. Send <code>title</code>, <code>url</code>, <code>company</code>, <code>description</code> and so on as JSON.</p>
      <p class="lead">AI features are <strong>${s.ai_enabled ? "on" : "off"}</strong>.${s.ai_enabled ? "" : " Add ANTHROPIC_API_KEY to your .env to turn on paste extraction, fit checks and tailoring."}</p>

      ${s.auth_required ? raw('<h2>Session</h2><div class="actions"><button class="btn" id="logout">Log out</button></div>') : ""}
    </div>`);

  const reload = () => { state.jobs = null; state.session = null; route(); };

  $main.querySelectorAll("[data-persona]").forEach((b) => b.addEventListener("click", () => editPersona(personas.find((p) => p.id === Number(b.dataset.persona)), personas)));
  document.getElementById("add-persona").addEventListener("click", () => editPersona(null, personas));

  document.getElementById("save-prefs").addEventListener("click", async () => {
    await api("/me", { method: "PATCH", json: { preferences: document.getElementById("prefs").value } });
    toast("Saved");
  });
  document.getElementById("save-name").addEventListener("click", async () => {
    try { await api("/me", { method: "PATCH", json: { name: document.getElementById("pname").value } }); toast("Renamed"); reload(); }
    catch (e) { toast(e.message, "error"); }
  });
  document.getElementById("switch")?.addEventListener("change", async (e) => {
    await api(`/users/${e.target.value}/select`, { method: "POST" });
    toast("Switched profile"); reload();
  });
  document.getElementById("new-user").addEventListener("click", async () => {
    const name = prompt("Name for the new profile");
    if (!name) return;
    try { await api("/users", { json: { name } }); toast(`Now using ${name}`); reload(); }
    catch (e) { toast(e.message, "error"); }
  });
  document.getElementById("del-user")?.addEventListener("click", async () => {
    if (!confirm(`Delete the profile “${s.user.name}” and all its jobs? This can't be undone.`)) return;
    await api(`/users/${s.user.id}`, { method: "DELETE" });
    toast("Profile deleted"); reload();
  });
  const upload = (input, path) => input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api(path, { method: "POST", body: fd });
      const added = r.jobs ?? r.added;
      toast(`Imported ${added} job${added === 1 ? "" : "s"}${r.duplicates ? `, skipped ${r.duplicates} already saved` : ""}`);
      state.jobs = null;
    } catch (e) { toast(e.message, "error"); }
    input.value = "";
  });
  upload(document.getElementById("imp-json"), "/import/backup");
  upload(document.getElementById("imp-csv"), "/import/csv");
  document.getElementById("logout")?.addEventListener("click", async () => {
    await api("/logout", { method: "POST" }); state.session = null; state.jobs = null; route();
  });
}

function editPersona(p, personas) {
  const box = document.getElementById("persona-editor");
  box.innerHTML = html`
    <form class="panel" id="f-persona" style="margin-top:16px">
      <div class="field"><label for="pn">Name</label><input id="pn" name="name" type="text" value="${p ? p.name : (personas.length ? "" : "Main resume")}" placeholder="e.g. Scrum Master" required></div>
      <div class="field"><label for="pr">Resume text</label><textarea id="pr" name="resume_text" class="tall" placeholder="Paste your full resume as plain text.">${p ? p.resume_text : ""}</textarea></div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">Save resume</button>
        ${p && !p.is_default ? raw('<button class="btn" type="button" id="p-default">Make default</button>') : ""}
        ${p ? raw('<button class="btn btn-ghost btn-danger" type="button" id="p-del">Delete</button>') : ""}
      </div>
    </form>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  const form = document.getElementById("f-persona");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { name: form.name.value, resume_text: form.resume_text.value };
    try {
      if (p) await api(`/personas/${p.id}`, { method: "PATCH", json: body });
      else await api("/personas", { json: body });
      toast("Resume saved"); renderSettings();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("p-default")?.addEventListener("click", async () => { await api(`/personas/${p.id}/default`, { method: "POST" }); renderSettings(); });
  document.getElementById("p-del")?.addEventListener("click", async () => {
    if (!confirm(`Delete the resume “${p.name}”?`)) return;
    await api(`/personas/${p.id}`, { method: "DELETE" }); renderSettings();
  });
}

// ---------- boot ----------

function handleShareIntent() {
  // Android share target (?share_url / ?share_text) and iOS Shortcut (?add=)
  const q = new URLSearchParams(location.search);
  const cand = q.get("add") || q.get("share_url") || q.get("share_text") || "";
  const m = cand.match(/https?:\/\/\S+/);
  if (m || q.has("add") || q.has("share_text") || q.has("share_url")) {
    history.replaceState(null, "", "/");
    if (m) location.hash = "#/add?url=" + encodeURIComponent(m[0]);
    else if (cand) location.hash = "#/add?mode=paste";
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("scroll", () => document.querySelector(".topbar").classList.toggle("scrolled", scrollY > 4), { passive: true });
handleShareIntent();
route();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
