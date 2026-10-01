// CatNews — pulls live stories from the HN Algolia API (CORS-friendly, no key needed)

const API = "https://hn.algolia.com/api/v1/search_by_date";
const REFRESH_MS = 60 * 1000;
const WINDOW_DAYS = 14;

// newsletter: paste your Buttondown embed URL here, e.g.
// "https://buttondown.com/api/emails/embed-subscribe/catnews"
const SUBSCRIBE_URL = "https://buttondown.com/api/emails/embed-subscribe/catnews";

// SOURCES lives in sources.js (shared with build-rss.js)
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
  if (typeof updateRail === "function") requestAnimationFrame(updateRail);
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
  // cat tilts + twitches its ears in the direction it walks
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
