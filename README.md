# dsh-exa

Exa neural search as a [DeepSeek Harness](https://github.com/deepseek-ai/dsh) tool: semantic web search, similar-page discovery, content extraction, and live Q&A — all wired into every agent preset via `ctx.tools`.

## Tools exposed

| Tool | What it does |
|---|---|
| `exa_search` | Semantic / keyword / auto web search with optional page text, highlights, and per-result summaries. Supports vertical filters (`company`, `research paper`, `news`, etc.). |
| `exa_find_similar` | Given a URL, return semantically similar pages. |
| `exa_get_contents` | Fetch and clean full text from one or more URLs. |
| `exa_answer` | Question-answering over the live web with citations. |

## Install

Set your Exa API key in the host shell:

```sh
export EXA_API_KEY="<your Exa key>"
```

Install into a profile:

```sh
dsh plugin --profile web add link:~/Documents/github/dsh-exa
```

Restart `dsh web`. The four tools appear in every agent preset.

## Configuration

The plugin reads a single environment variable:

| Variable | Required | Notes |
|---|---|---|
| `EXA_API_KEY` | yes | Get one at <https://dashboard.exa.ai>. |

If `EXA_API_KEY` is unset when `apply` runs, the plugin logs an error and **does not** register any tools — the host console will show `[dsh-exa] EXA_API_KEY not set — tools NOT registered.`

## Development

```sh
# Edit lib/index.js, then reload `dsh web` — patchReload is "live" by default.
node --check lib/index.js
```

## License

MIT
