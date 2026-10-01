// CatNews — merges our own first-party newsroom (news.json, built by build-news.js)
// with live community stories from Hacker News.

const HN_API = "https://hn.algolia.com/api/v1/search_by_date";
const REFRESH_MS = 60 * 1000;
const WINDOW_DAYS = 14;

// newsletter: paste your Buttondown embed URL here, e.g.
// "https://buttondown.com/api/emails/embed-subscribe/catnews"
const SUBSCRIBE_URL = "";

// the newsroom runs every minute on Cloudflare (worker/); the repo copy is the fallback
const NEWSROOM_URL = "https://catnews-newsroom.itsizzydudee.workers.dev/news.json";

async function fetchNewsroom() {
  for (const url of [NEWSROOM_URL, `news.json?t=${Date.now()}`]) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {}
  }
  throw new Error("newsroom unreachable");
}

// SOURCES lives in sources.js (shared with the builders)
const BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
const KIND_LABEL = { release: "Release", model: "New model", post: "Official post" };

const state = {
  stories: new Map(), // id -> story
  seen: new Set(),
  newsroom: null,     // last news.json
  active: "all",
  query: "",
  feed: "latest",
  replay: true,
  ready: false,       // true after the first full load, so only later arrivals get "new"
};

const $ = (sel) => document.querySelector(sel);
const feedEl = $("#feed");
const leadEl = $("#lead");
const emptyEl = $("#empty");

/* ---------- loading ---------- */

async function loadOfficial() {
  const data = await fetchNewsroom();
  state.newsroom = data;
  for (const i of data.items) {
    const id = `o:${i.id}`;
    const existing = state.stories.get(id);
    state.stories.set(id, {
      id,
      official: true,
      title: i.title,
      url: i.url,
      summary: i.summary,
      kind: i.kind,
      from: i.from,
      time: i.publishedAt,
      tags: new Set([i.source]),
      lagMs: i.lagMs,
      lagIsUpperBound: i.lagIsUpperBound,
      points: existing?.points,
      comments: existing?.comments,
      hnId: existing?.hnId || i.hn?.id,
    });
  }
}

async function fetchCommunity(src) {
  const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
  const results = await Promise.allSettled(
    src.terms.map((term) => {
      const params = new URLSearchParams({ query: term, tags: "story", numericFilters: `created_at_i>${since}`, hitsPerPage: "30" });
      return fetch(`${HN_API}?${params}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
    })
  );
  return results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value.hits)
    .filter((h) => h.title && matches(h.title, src.terms));
}

// the term has to really be in the headline (Algolia also matches urls/typos)
function matches(title, terms) {
  const t = title.toLowerCase();
  return terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
}

async function loadCommunity() {
  const results = await Promise.allSettled(SOURCES.map(fetchCommunity));
  const officialByUrl = new Map([...state.stories.values()].filter((s) => s.official).map((s) => [normUrl(s.url), s]));
  let ok = 0;

  results.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    ok++;
    for (const hit of res.value) {
      // same link as one of our official stories? attach the discussion to it instead
      const twin = hit.url && officialByUrl.get(normUrl(hit.url));
      if (twin) {
        twin.points = hit.points || 0;
        twin.comments = hit.num_comments || 0;
        twin.hnId = hit.objectID;
        continue;
      }
      const id = `hn:${hit.objectID}`;
      const s = state.stories.get(id);
      if (s) {
        s.points = hit.points || 0;
        s.comments = hit.num_comments || 0;
        s.tags.add(SOURCES[i].id);
      } else {
        state.stories.set(id, {
          id,
          official: false,
          title: hit.title,
          url: hit.url,
          time: hit.created_at_i * 1000,
          points: hit.points || 0,
          comments: hit.num_comments || 0,
          hnId: hit.objectID,
          tags: new Set([SOURCES[i].id]),
        });
      }
    }
  });
  if (!ok) throw new Error("hn down");
}

async function loadAll() {
  setStatus("loading", "checking…");
  $("#refresh").classList.add("spin");
  // official first (it's local and fast), so community stories can attach to it
  const official = await loadOfficial().then(() => true, () => false);
  if (official) render();
  const community = await loadCommunity().then(() => true, () => false);

  const ok = official || community;
  setStatus(ok ? "live" : "err", ok ? `live · ${clock()}` : "offline — retrying");
  $("#refresh").classList.remove("spin");
  render();
  state.ready = true;
}

/* ---------- rendering ---------- */

function logo(src) {
  if (!src) return `<span class="co"></span>`;
  return `<span class="co" data-letter="${src.label[0]}"><img src="https://www.google.com/s2/favicons?domain=${src.domain}&sz=64" alt="" loading="lazy" onerror="this.parentNode.textContent=this.parentNode.dataset.letter"></span>`;
}

function renderChips() {
  const counts = { all: state.stories.size };
  for (const s of state.stories.values()) for (const t of s.tags) counts[t] = (counts[t] || 0) + 1;
  const chip = (id, label, inner) =>
    `<button class="chip${id === "all" ? " all" : ""}" data-source="${id}" aria-pressed="${state.active === id}">${inner}${label}<span class="count">${counts[id] || 0}</span></button>`;
  $("#sources").innerHTML = chip("all", "All", "") + SOURCES.map((s) => chip(s.id, s.label, logo(s))).join("");
  if (typeof updateRail === "function") requestAnimationFrame(updateRail);
}

function renderStats() {
  const n = state.newsroom;
  if (!n) return;
  const week = n.items.filter((i) => Date.now() - i.publishedAt < 7 * 86400e3).length;
  const lags = n.items.filter((i) => i.lagMs != null).map((i) => i.lagMs).sort((a, b) => a - b);
  const median = lags.length ? lags[Math.floor(lags.length / 2)] : null;
  $("#stats").innerHTML = [
    `<span><b>${week}</b> first-party stories this week</span>`,
    `<span><b>${n.watched.length}</b> official sources watched</span>`,
    `<span>checked every <b>minute</b></span>`,
    median != null ? `<a href="/our-speed/">median catch time ${duration(median)} →</a>` : `<a href="/our-speed/">our speed →</a>`,
  ].join("");
}

function kindLabel(s) {
  if (!s.official) return `<span class="kind">Community</span>`;
  return `<span class="kind ${s.kind === "post" ? "official" : s.kind}">${KIND_LABEL[s.kind] || "Official"}</span>`;
}

function meta(s, { linkComments = true } = {}) {
  const hn = s.hnId && `https://news.ycombinator.com/item?id=${s.hnId}`;
  return [
    `<span class="src">${[...s.tags].map((t) => BY_ID[t]?.label).join(", ")}</span>`,
    kindLabel(s),
    s.url ? `<span>${domain(s.url)}</span>` : "",
    s.points != null ? `<span>${s.points} pts</span>` : "",
    hn ? (linkComments ? `<a href="${hn}" target="_blank" rel="noopener">${s.comments ?? 0} comments</a>` : `<span>${s.comments ?? 0} comments</span>`) : "",
  ].join("");
}

function dayLabel(ms) {
  const d = new Date(ms);
  const days = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400e3);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function render() {
  renderChips();
  renderStats();

  const q = state.query.toLowerCase();
  const dayAgo = Date.now() - 86400e3;
  let list = [...state.stories.values()].filter(
    (s) =>
      (state.active === "all" || s.tags.has(state.active)) &&
      (!q || s.title.toLowerCase().includes(q)) &&
      (state.feed !== "official" || s.official) &&
      (state.feed !== "trending" || (!s.official && s.time > Date.now() - 2 * 86400e3))
  );
  list.sort(state.feed === "trending" ? (a, b) => b.points - a.points : (a, b) => b.time - a.time);
  list = list.slice(0, 120);

  emptyEl.hidden = list.length > 0 || state.stories.size === 0;

  // lead: newest official post or model from the last day, else the most discussed community story
  let lead = null;
  if (!q && state.feed !== "trending") {
    lead =
      list.find((s) => s.official && s.kind !== "release" && s.time > dayAgo) ||
      list.filter((s) => !s.official && s.time > dayAgo).sort((a, b) => b.points - a.points)[0] ||
      null;
  }

  leadEl.innerHTML = lead
    ? `<a class="lead" href="${esc(lead.url || `https://news.ycombinator.com/item?id=${lead.hnId}`)}" target="_blank" rel="noopener">
        <div class="lead-label">${logo(BY_ID[[...lead.tags][0]])} ${lead.official ? `from ${esc(lead.from)}` : "most discussed today"} · ${ago(lead.time)} ago</div>
        <span class="lead-title">${esc(lead.title)}</span>
        ${lead.summary ? `<p class="summary">${esc(lead.summary)}</p>` : ""}
        <div class="meta">${meta(lead, { linkComments: false })}</div>
      </a>`
    : "";

  let lastDay = "";
  let i = 0;
  feedEl.innerHTML = list
    .filter((s) => s !== lead)
    .map((s) => {
      let header = "";
      if (state.feed !== "trending") {
        const day = dayLabel(s.time);
        if (day !== lastDay) header = `<li class="day">${day}</li>`;
        lastDay = day;
      }
      const isFresh = state.ready && !state.seen.has(s.id);
      const enter = state.replay || !state.seen.has(s.id);
      const href = s.url || `https://news.ycombinator.com/item?id=${s.hnId}`;
      const hot = Date.now() - s.time < 3600e3;
      const caught = s.lagMs != null
        ? `<span class="caught" title="Time between the source publishing and CatNews picking it up">caught in ${s.lagIsUpperBound ? "≤" : ""}${duration(s.lagMs)}</span>`
        : "";
      return `${header}<li class="item${enter ? " enter" : ""}${isFresh ? " fresh" : ""}" style="--i:${Math.min(i++, 15)}">
        ${logo(BY_ID[[...s.tags][0]])}
        <div>
          <a class="title" href="${esc(href)}" target="_blank" rel="noopener">${esc(s.title)}</a>
          ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ""}
          <div class="meta">${meta(s)}</div>
        </div>
        <div class="side">
          <span class="ago${hot ? " hot" : ""}" title="${new Date(s.time).toLocaleString()}">${ago(s.time)}</span>
          ${caught}
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

function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function normUrl(url) {
  return (url || "").replace(/^https?:\/\/(www\.)?/, "").replace(/[/#?]+$/, "");
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

document.querySelectorAll("[data-feed]").forEach((b) =>
  b.addEventListener("click", () => {
    state.feed = b.dataset.feed;
    document.querySelectorAll("[data-feed]").forEach((x) => x.setAttribute("aria-pressed", x === b));
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

addEventListener("scroll", () => $("#top").classList.toggle("scrolled", scrollY > 8), { passive: true });

/* ---------- source rail: smooth wheel scroll + cat scrollbar ---------- */

const rail = $("#rail");
const scroller = $("#sources");
const cat = $("#rail-cat");
const track = $("#rail-track");
let target = 0;      // where we're easing toward
let animating = false;
let walkTimer;

const maxScroll = () => scroller.scrollWidth - scroller.clientWidth;
const clamp = (v) => Math.max(0, Math.min(maxScroll(), v));

function glideTo(x) {
  target = clamp(x);
  if (!animating) { animating = true; requestAnimationFrame(glide); }
}

function glide() {
  const diff = target - scroller.scrollLeft;
  if (Math.abs(diff) < 0.5) {
    scroller.scrollLeft = target;
    animating = false;
    return;
  }
  scroller.scrollLeft += diff * 0.18; // ease-out
  requestAnimationFrame(glide);
}

function updateRail() {
  const max = maxScroll();
  const pct = max > 0 ? scroller.scrollLeft / max : 0;
  rail.classList.toggle("scrollable", max > 4);
  rail.classList.toggle("can-left", scroller.scrollLeft > 4);
  rail.classList.toggle("can-right", scroller.scrollLeft < max - 4);
  cat.style.left = `${pct * 100}%`;
  $("#rail-fill").style.width = `${pct * 100}%`;
}

let lastLeft = 0;
scroller.addEventListener("scroll", () => {
  // the cat leans the way it rolls
  const dir = scroller.scrollLeft > lastLeft ? "walk-right" : "walk-left";
  lastLeft = scroller.scrollLeft;
  cat.classList.remove("walk-left", "walk-right");
  cat.classList.add(dir);
  clearTimeout(walkTimer);
  walkTimer = setTimeout(() => cat.classList.remove("walk-left", "walk-right"), 180);
  updateRail();
}, { passive: true });

// vertical mouse wheel scrolls the chips sideways (only while there's room to)
scroller.addEventListener("wheel", (e) => {
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const base = animating ? target : scroller.scrollLeft;
  if ((delta < 0 && base <= 0) || (delta > 0 && base >= maxScroll())) return;
  e.preventDefault();
  glideTo(base + delta * 1.2);
}, { passive: false });

$("#rail-left").addEventListener("click", () => glideTo(scroller.scrollLeft - scroller.clientWidth * 0.7));
$("#rail-right").addEventListener("click", () => glideTo(scroller.scrollLeft + scroller.clientWidth * 0.7));

// drag the cat, or click anywhere on the track to jump there
function scrollFromPointer(e) {
  const r = track.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * maxScroll();
}

track.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  cat.classList.add("dragging");
  track.setPointerCapture(e.pointerId);
  glideTo(scrollFromPointer(e));
  const move = (ev) => glideTo(scrollFromPointer(ev));
  const up = () => {
    cat.classList.remove("dragging");
    track.removeEventListener("pointermove", move);
    track.removeEventListener("pointerup", up);
  };
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
});

// drag the chip row itself with the mouse
let drag = null;
scroller.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") return;
  drag = { x: e.clientX, left: scroller.scrollLeft, moved: false };
});
addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 4) drag.moved = true;
  if (drag.moved) { target = scroller.scrollLeft = clamp(drag.left - dx); }
});
addEventListener("pointerup", () => setTimeout(() => (drag = null)));
// don't treat the end of a drag as a click on a chip
scroller.addEventListener("click", (e) => { if (drag?.moved) e.stopPropagation(); }, true);

new ResizeObserver(updateRail).observe(scroller);

/* ---------- subscribe ---------- */

$("#subscribe").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const input = $("#sub-email");
  const msg = $("#sub-msg");
  const btn = form.querySelector("button");
  const email = input.value.trim();

  const fail = (text) => {
    msg.textContent = text;
    msg.className = "sub-msg bad";
    form.classList.remove("shake");
    form.offsetWidth;
    form.classList.add("shake");
  };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("That doesn't look like an email… meow?");
  if (!SUBSCRIBE_URL) return fail("Subscriptions open soon — check back in a bit!");

  btn.disabled = true;
  btn.textContent = "…";
  try {
    // Buttondown's embed endpoint doesn't send CORS headers, so we can't read the reply
    await fetch(SUBSCRIBE_URL, { method: "POST", mode: "no-cors", body: new URLSearchParams({ email }) });
    msg.textContent = "You're in! Check your inbox to confirm :O";
    msg.className = "sub-msg ok";
    input.value = "";
  } catch {
    fail("Couldn't reach the server — try again?");
  } finally {
    btn.disabled = false;
    btn.textContent = "Subscribe";
  }
});

/* ---------- go ---------- */

renderChips();
renderSkeleton();
loadAll();
setInterval(loadAll, REFRESH_MS);
// keep the "5m" labels fresh between fetches
setInterval(render, 30 * 1000);

// splash: hold briefly so the logo animation can play, then fade the page in
setTimeout(() => document.body.classList.remove("loading"), 900);
