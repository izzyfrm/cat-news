// tokenfeed — pulls live stories from the HN Algolia API (CORS-friendly, no key needed)

const API = "https://hn.algolia.com/api/v1/search_by_date";
const REFRESH_MS = 60 * 1000;
const WINDOW_DAYS = 14;

// each source = a label + the search terms that count as a match
const SOURCES = [
  { id: "claude",     label: "Claude",     terms: ["claude", "anthropic"] },
  { id: "openai",     label: "OpenAI",     terms: ["openai", "chatgpt", "gpt-5", "gpt-4", "sora", "codex"] },
  { id: "gemini",     label: "Gemini",     terms: ["gemini", "deepmind", "google ai"] },
  { id: "deepseek",   label: "DeepSeek",   terms: ["deepseek"] },
  { id: "grok",       label: "Grok",       terms: ["grok", "xai"] },
  { id: "grokbots",   label: "Grok Bots",  terms: ["grok bot", "grok companion", "grok agent"] },
  { id: "muse",       label: "Muse",       terms: ["muse ai", "muse model", "meta muse"] },
  { id: "kimi",       label: "Kimi",       terms: ["kimi", "moonshot ai"] },
  { id: "perplexity", label: "Perplexity", terms: ["perplexity"] },
  { id: "opencode",   label: "OpenCode",   terms: ["opencode", "opencode.ai"] },
];

const state = {
  stories: new Map(), // objectID -> story
  seen: new Set(),
  active: "all",
  query: "",
  sort: "new",
};

const $ = (sel) => document.querySelector(sel);
const feedEl = $("#feed");
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
  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  let ok = 0;

  results.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    ok++;
    for (const hit of res.value) {
      const existing = state.stories.get(hit.objectID);
      if (existing) {
        existing.points = hit.points;
        existing.comments = hit.num_comments;
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

  if (ok === 0) {
    setStatus("err", "offline — retrying");
  } else {
    setStatus("live", `live · updated ${clock()}`);
  }
  render();
}

/* ---------- rendering ---------- */

function renderChips() {
  const counts = { all: state.stories.size };
  for (const s of state.stories.values()) {
    for (const t of s.tags) counts[t] = (counts[t] || 0) + 1;
  }

  const all = [{ id: "all", label: "All" }, ...SOURCES];
  $("#sources").innerHTML = all
    .map(
      (s) => `<button class="chip" data-source="${s.id}" aria-pressed="${state.active === s.id}">
        ${s.label}<span class="count">${counts[s.id] || 0}</span></button>`
    )
    .join("");
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

  feedEl.innerHTML = list
    .map((s) => {
      const isFresh = !firstLoad && !state.seen.has(s.id);
      const hn = `https://news.ycombinator.com/item?id=${s.id}`;
      const tags = [...s.tags].map((t) => SOURCES.find((x) => x.id === t).label).join(", ");
      const recent = Date.now() - s.time < 3600 * 1000;
      return `<li class="item${isFresh ? " fresh" : ""}">
        <span class="time${recent ? " new" : ""}" title="${new Date(s.time).toLocaleString()}">${ago(s.time)}</span>
        <div>
          <a class="title" href="${esc(s.url || hn)}" target="_blank" rel="noopener">${esc(s.title)}</a>
          <div class="meta">
            <span class="tag">${tags}</span>
            ${s.url ? `<span>${domain(s.url)}</span>` : ""}
            <span>${s.points} pts</span>
            <a href="${hn}" target="_blank" rel="noopener">${s.comments} comments</a>
          </div>
        </div>
      </li>`;
    })
    .join("");

  list.forEach((s) => state.seen.add(s.id));
}

function renderSkeleton() {
  feedEl.innerHTML = Array.from({ length: 8 }, () =>
    `<li class="item skeleton"><span class="bar"></span><div><div class="bar" style="width:80%"></div><div class="bar" style="width:40%"></div></div></li>`
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
  render();
}

/* ---------- theme ---------- */

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

$("#theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-source]");
  if (!btn) return;
  e.preventDefault();
  setSource(btn.dataset.source);
});

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});

$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  render();
});

$("#refresh").addEventListener("click", loadAll);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  else if (e.key === "r") loadAll();
  else if (e.key === "0") setSource("all");
  else if (/^[1-9]$/.test(e.key)) setSource(SOURCES[+e.key - 1].id);
});

/* ---------- go ---------- */

initTheme();
renderChips();
renderSkeleton();
loadAll();
setInterval(loadAll, REFRESH_MS);
// keep the "5m ago" labels fresh between fetches
setInterval(() => document.querySelectorAll(".time").length && render(), 30 * 1000);
