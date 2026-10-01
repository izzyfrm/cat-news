// CatNews sources — shared by the site (script.js) and the builders (build-news.js, build-rss.js)
//
// terms  = words that tag a community (Hacker News) story with this source
// domain = where the logo comes from

const SOURCES = [
  { id: "claude",      label: "Claude",      domain: "claude.ai",         terms: ["claude", "anthropic"] },
  { id: "openai",      label: "OpenAI",      domain: "openai.com",        terms: ["openai", "chatgpt", "gpt-5", "gpt-4", "sora", "codex"] },
  { id: "gemini",      label: "Gemini",      domain: "gemini.google.com", terms: ["gemini", "deepmind", "google ai", "gemma"] },
  { id: "deepseek",    label: "DeepSeek",    domain: "deepseek.com",      terms: ["deepseek"] },
  { id: "grok",        label: "Grok",        domain: "grok.com",          terms: ["grok", "xai"] },
  { id: "grokbots",    label: "Grok Bots",   domain: "x.ai",              terms: ["grok bot", "grok companion", "grok agent"] },
  { id: "muse",        label: "Muse",        domain: "meta.ai",           terms: ["muse ai", "muse model", "meta muse"] },
  { id: "kimi",        label: "Kimi",        domain: "kimi.com",          terms: ["kimi", "moonshot ai"] },
  { id: "perplexity",  label: "Perplexity",  domain: "perplexity.ai",     terms: ["perplexity"] },
  { id: "opencode",    label: "OpenCode",    domain: "opencode.ai",       terms: ["opencode", "opencode.ai"] },
  { id: "mistral",     label: "Mistral",     domain: "mistral.ai",        terms: ["mistral", "mixtral", "codestral", "le chat"] },
  { id: "meta",        label: "Llama",       domain: "llama.com",         terms: ["llama", "meta ai"] },
  { id: "qwen",        label: "Qwen",        domain: "qwen.ai",           terms: ["qwen"] },
  { id: "huggingface", label: "Hugging Face", domain: "huggingface.co",   terms: ["hugging face", "huggingface"] },
  { id: "cursor",      label: "Cursor",      domain: "cursor.com",        terms: ["cursor ai", "cursor ide", "cursor editor", "cursor's"] },
  { id: "copilot",     label: "Copilot",     domain: "github.com",        terms: ["copilot"] },
];

if (typeof module !== "undefined") module.exports = SOURCES;
