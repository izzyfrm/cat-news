// CatNews — pulls live stories from the HN Algolia API (CORS-friendly, no key needed)

const API = "https://hn.algolia.com/api/v1/search_by_date";
const REFRESH_MS = 60 * 1000;
const WINDOW_DAYS = 14;

// each source = label, the domain we pull its logo from, and the search terms that count as a match
const SOURCES = [
  { id: "claude",     label: "Claude",     domain: "claude.ai",         terms: ["claude", "anthropic"] },
  { id: "openai",     label: "OpenAI",     domain: "openai.com",        terms: ["openai", "chatgpt", "gpt-5", "gpt-4", "sora", "codex"] },
  { id: "gemini",     label: "Gemini",     domain: "gemini.google.com", terms: ["gemini", "deepmind", "google ai"] },
  { id: "deepseek",   label: "DeepSeek",   domain: "deepseek.com",      terms: ["deepseek"] },
  { id: "grok",       label: "Grok",       domain: "grok.com",          terms: ["grok", "xai"] },
  { id: "grokbots",   label: "Grok Bots",  domain: "x.ai",              terms: ["grok bot", "grok companion", "grok agent"] },
  { id: "muse",       label: "Muse",       domain: "meta.ai",           terms: ["muse ai", "muse model", "meta muse"] },
  { id: "kimi",       label: "Kimi",       domain: "kimi.com",          terms: ["kimi", "moonshot ai"] },
  { id: "perplexity", label: "Perplexity", domain: "perplexity.ai",     terms: ["perplexity"] },
  { id: "opencode",   label: "OpenCode",   domain: "opencode.ai",       terms: ["opencode", "opencode.ai"] },
];
const BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));

const state = {
  stories: new Map(), // objectID -> story
  seen: new Set(),
  active: "all",
  query: "",
  sort: "new",
  replay: true, // replay the entry animation on the next render
};

const $ = (sel) => document.querySelector(sel);
const feedEl = $("#feed");
const leadEl = $("#lead");
const emptyEl = $("#empty");

/* ---------- fetching ---------- */

async function fetchSource(src) {
  const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
  // Algolia treats space-separated words as AND, so query each term separately
  const requests = src.terms.map((term) => {
    const params = new URLSearchParams({
      query: term,
      tags: "story",
      numericFilters: `created_at_i>${since}`,
      hitsPerPage: "30",
    });
    return fetch(`${API}?${params}`).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  });

  const results = await Promise.allSettled(requests);
  const hits = [];
  for (const res of results) {
    if (res.status === "fulfilled") hits.push(...res.value.hits);
  }
  return hits.filter((h) => h.title && matches(h.title, src.terms));
}

// make sure the term really appears in the title (Algolia also matches urls/typos)
function matches(title, terms) {
  const t = title.toLowerCase();
  return terms.some((term) => new RegExp(`\\b${escapeRe(term)}\\b`).test(t));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadAll() {
  setStatus("loading", "fetching…");
  $("#refresh").classList.add("spin");
  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  let ok = 0;

  results.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    ok++;
    for (const hit of res.value) {
      const existing = state.stories.get(hit.objectID);
      if (existing) {
        existing.points = hit.points || 0;
        existing.comments = hit.num_comments || 0;
        existing.tags.add(SOURCES[i].id);
      } else {
        state.stories.set(hit.objectID, {
          id: hit.objectID,
          title: hit.title,
          url: hit.url,
          author: hit.author,
          points: hit.points || 0,
          comments: hit.num_comments || 0,
          time: hit.created_at_i * 1000,
          tags: new Set([SOURCES[i].id]),
        });
      }
    }
  });

  setStatus(ok ? "live" : "err", ok ? `live · ${clock()}` : "offline — retrying");
  $("#refresh").classList.remove("spin");
  render();
}

/* ---------- rendering ---------- */

function logo(src, cls = "co") {
  if (!src) return `<span class="${cls}"></span>`;
  // google's favicon service; falls back to the first letter if it fails
  return `<span class="${cls}" data-letter="${src.label[0]}"><img src="https://www.google.com/s2/favicons?domain=${src.domain}&sz=64" alt="" loading="lazy" onerror="this.parentNode.textContent=this.parentNode.dataset.letter"></span>`;
}

function renderChips() {
  const counts = { all: state.stories.size };
  for (const s of state.stories.values()) {
    for (const t of s.tags) counts[t] = (counts[t] || 0) + 1;
  }

  const chip = (id, label, inner) =>
    `<button class="chip${id === "all" ? " all" : ""}" data-source="${id}" aria-pressed="${state.active === id}">${inner}${label}<span class="count">${counts[id] || 0}</span></button>`;

  $("#sources").innerHTML =
    chip("all", "All", "") + SOURCES.map((s) => chip(s.id, s.label, logo(s))).join("");
}

function meta(s) {
  const src = BY_ID[[...s.tags][0]];
  const hn = `https://news.ycombinator.com/item?id=${s.id}`;
  return `<span class="src">${[...s.tags].map((t) => BY_ID[t].label).join(", ")}</span>
    ${s.url ? `<span>${domain(s.url)}</span>` : ""}
    <span>${s.points} pts</span>
    <a href="${hn}" target="_blank" rel="noopener">${s.comments} comments</a>`;
}

function render() {
  renderChips();

  const q = state.query.toLowerCase();
  let list = [...state.stories.values()].filter(
    (s) =>
      (state.active === "all" || s.tags.has(state.active)) &&
      (!q || s.title.toLowerCase().includes(q))
  );

  list.sort(state.sort === "top" ? (a, b) => b.points - a.points : (a, b) => b.time - a.time);
  list = list.slice(0, 100);

  emptyEl.hidden = list.length > 0 || state.stories.size === 0;
  const firstLoad = state.seen.size === 0;

  // lead = most discussed story from the last 24h in the current view
  const dayAgo = Date.now() - 86400 * 1000;
  const lead = q ? null : list.filter((s) => s.time > dayAgo).sort((a, b) => b.points - a.points)[0];

  leadEl.innerHTML = lead
    ? `<a class="lead" href="${esc(lead.url || `https://news.ycombinator.com/item?id=${lead.id}`)}" target="_blank" rel="noopener">
        <div class="lead-label">${logo(BY_ID[[...lead.tags][0]])} top story today · ${ago(lead.time)} ago</div>
        <span class="lead-title">${esc(lead.title)}</span>
        <div class="meta">${meta(lead).replace(/<a [^>]*>(.*?)<\/a>/, "<span>$1</span>")}</div>
      </a>`
    : "";
  if (state.replay && leadEl.firstChild) {
    // restart the css animation
    leadEl.firstElementChild.style.animation = "none";
    leadEl.firstElementChild.offsetHeight;
    leadEl.firstElementChild.style.animation = "";
  }

  feedEl.innerHTML = list
    .filter((s) => s !== lead)
    .map((s, i) => {
      const isFresh = !firstLoad && !state.seen.has(s.id);
      const enter = state.replay || !state.seen.has(s.id);
      const hn = `https://news.ycombinator.com/item?id=${s.id}`;
      const hot = Date.now() - s.time < 3600 * 1000;
      return `<li class="item${enter ? " enter" : ""}${isFresh ? " fresh" : ""}" style="--i:${Math.min(i, 15)}">
        ${logo(BY_ID[[...s.tags][0]])}
        <div>
          <a class="title" href="${esc(s.url || hn)}" target="_blank" rel="noopener">${esc(s.title)}</a>
          <div class="meta">${meta(s)}</div>
        </div>
        <div class="side">
          <span class="ago${hot ? " hot" : ""}" title="${new Date(s.time).toLocaleString()}">${ago(s.time)}</span>
        </div>
      </li>`;
    })
    .join("");

  list.forEach((s) => state.seen.add(s.id));
  state.replay = false;
}

function renderSkeleton() {
  feedEl.innerHTML = Array.from({ length: 8 }, () =>
    `<li class="item skeleton"><span class="co"></span><div><div class="bar" style="width:85%"></div><div class="bar" style="width:40%"></div></div><span></span></li>`
  ).join("");
}

/* ---------- helpers ---------- */

function ago(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function clock() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setStatus(kind, text) {
  $("#dot").className = "dot" + (kind === "live" ? " live" : kind === "err" ? " err" : "");
  $("#status-text").textContent = text;
}

function setSource(id) {
  state.active = id;
  state.replay = true;
  render();
}

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-source]");
  if (!btn) return;
  e.preventDefault();
  setSource(btn.dataset.source);
  if (btn.classList.contains("logo")) scrollTo({ top: 0 });
});

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});

document.querySelectorAll("[data-sort]").forEach((b) =>
  b.addEventListener("click", () => {
    state.sort = b.dataset.sort;
    document.querySelectorAll("[data-sort]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    state.replay = true;
    render();
  })
);

$("#refresh").addEventListener("click", loadAll);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  else if (e.key === "r") loadAll();
  else if (e.key === "0") setSource("all");
  else if (/^[1-9]$/.test(e.key)) setSource(SOURCES[+e.key - 1].id);
});

// border under the header only once you scroll
addEventListener("scroll", () => $("#top").classList.toggle("scrolled", scrollY > 8), { passive: true });

/* ---------- go ---------- */

renderChips();
renderSkeleton();
loadAll();
setInterval(loadAll, REFRESH_MS);
// keep the "5m" labels fresh between fetches
setInterval(render, 30 * 1000);

// splash: hold briefly so the logo animation can play, then fade the page in
setTimeout(() => document.body.classList.remove("loading"), 900);
