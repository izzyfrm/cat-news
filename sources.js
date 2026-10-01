// CatNews sources — shared by the site (script.js) and the feed builder (build-rss.js)

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

if (typeof module !== "undefined") module.exports = SOURCES;
