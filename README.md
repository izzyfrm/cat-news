# CatNews :O

**AI news for developers, straight from the source.** → [catnews.space](https://catnews.space)

![CatNews homepage](docs/screenshot.png)

CatNews watches the AI labs directly (their GitHub releases, Hugging Face model uploads, official blogs and sitemaps) and turns anything new into a story within minutes. Community discussion from Hacker News shows up right alongside it.

Covers Claude/Anthropic, OpenAI, Gemini/Google, DeepSeek, Grok, Kimi, Perplexity, OpenCode, Mistral, Llama, Qwen, Hugging Face, Cursor and GitHub Copilot.

## Why it's fast

Most AI news sites wait for someone to write an article about a release. CatNews skips that step:

| Source type | Example | Timestamp |
| --- | --- | --- |
| GitHub releases | `anthropics/claude-code`, `openai/codex` | exact |
| Hugging Face uploads | `deepseek-ai`, `Qwen`, `moonshotai` | exact |
| Official blog feeds | OpenAI, DeepMind, Cursor changelog | from the feed |
| Sitemaps | Anthropic, Mistral, DeepSeek | first time a new URL appears |

Every story records when it was published and when we caught it, and we check whether Hacker News got there first. The results are public at **[catnews.space/our-speed](https://catnews.space/our-speed/)**.

## How it works

```
GitHub Action (every 5 min)
  └─ build-news.js  → news.json   first-party stories + catch times
  └─ build-rss.js   → rss.xml     big stories, for RSS readers & email
Browser
  └─ script.js      → reads news.json + live Hacker News, merges them
```

No framework, no build step, no dependencies. Plain HTML, CSS and JavaScript.

| File | What it does |
| --- | --- |
| `index.html` · `style.css` · `script.js` | the news page |
| `our-speed/index.html` | the speed benchmark |
| `sources.js` | the list of sources, shared by the site and the builders |
| `build-news.js` | the newsroom: checks every official source |
| `build-rss.js` | builds the RSS feed |
| `space.js` | the animated starfield |

## Run it locally

```bash
node build-news.js
python -m http.server 5500
```

Then open http://localhost:5500. Node 18+ is needed for the builders; nothing to install.

## Feeds

- RSS: [catnews.space/rss.xml](https://catnews.space/rss.xml)
- Raw data: [catnews.space/news.json](https://catnews.space/news.json)

## Made by

[Isaiah Boyd](https://izzyy.me) · [@izzyfrm](https://github.com/izzyfrm). More at [info.catnews.space](https://info.catnews.space).
