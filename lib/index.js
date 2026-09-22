/**
 * dsh-exa — Exa neural search as a DSH tool.
 *
 * Tools exposed (4):
 *   - exa_search        semantic/keyword web search with optional content
 *   - exa_find_similar  pages similar to a given URL
 *   - exa_get_contents  fetch + summarize text from one or more URLs
 *   - exa_answer        Q&A over the live web with citations
 *
 * Configuration:
 *   API key resolution order (first non-empty wins):
 *     1. Settings → dsh-exa → API Key (role: secret, stored encrypted by DSH)
 *     2. Launching env var named by `apiKeyEnv` (default "EXA_API_KEY")
 *
 *   Other settings: defaultNumResults, defaultType, requestTimeoutMs.
 *
 *   The settings page is installed automatically under the "dsh-exa"
 *   namespace — open Settings → Plugins → dsh-exa to configure.
 */

import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { defineTool } from '@deepseek-ai/dsh-tools';

const EXA_BASE = 'https://api.exa.ai';
const DEFAULT_API_KEY_ENV = 'EXA_API_KEY';
const SETTINGS_NAMESPACE = 'dsh-exa';

export const name = 'dsh-exa';
export const inject = ['tools', 'settings'];

// ── Settings schema ──────────────────────────────────────────────────────
const Config = z.object({
  apiKey: z.string().role('secret').description(
    'Your Exa API key. Get one at https://dashboard.exa.ai. ' +
    'Leave empty to fall back to the env var named by `apiKeyEnv`.'
  ),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).description(
    'Name of the env var that holds the Exa API key, used when the ' +
    'literal `apiKey` field above is empty. Default: EXA_API_KEY.'
  ),
  defaultNumResults: z.number().step(1).min(1).max(20).default(8).description(
    'Default number of results for exa_search / exa_find_similar / exa_answer.'
  ),
  defaultType: z.string().default('auto').description(
    'Default search type for exa_search: "neural" | "keyword" | "auto".'
  ),
  requestTimeoutMs: z.number().step(1000).min(5000).max(120000).default(30000).description(
    'Per-request timeout in milliseconds (exa_answer uses 2× this).'
  ),
});

// ── HTTP helper ──────────────────────────────────────────────────────────
async function exa(path, body, apiKey, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${EXA_BASE}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'x-exa-integration': 'dsh-exa/0.2.0',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Exa ${path} ${res.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// ── Render helpers ───────────────────────────────────────────────────────
function renderResults(results) {
  if (!results?.length) return 'No results.';
  return results.map((r, i) => {
    const title    = r.title || '(no title)';
    const url      = r.url || '';
    const pub      = r.publishedDate ? ` · ${r.publishedDate}` : '';
    const author   = r.author ? ` · ${r.author}` : '';
    const text     = r.text      ? `\n   ${r.text.slice(0, 600)}${r.text.length > 600 ? '…' : ''}` : '';
    const summary  = r.summary   ? `\n   summary: ${r.summary}` : '';
    const hl       = r.highlights?.length
      ? `\n   highlights: ${r.highlights.slice(0, 3).map(h => h.slice(0, 200)).join(' | ')}`
      : '';
    return `${i + 1}. ${title}${pub}${author}\n   ${url}${text}${summary}${hl}`;
  }).join('\n\n');
}

function renderAnswer(value) {
  const lines = [];
  if (value.answer) lines.push(value.answer);
  const cites = value.citations || value.sources || [];
  if (cites.length) {
    lines.push('\nCitations:');
    cites.slice(0, 10).forEach((c, i) => {
      const url   = typeof c === 'string' ? c : c.url;
      const title = typeof c === 'string' ? '' : (c.title || '');
      lines.push(`  ${i + 1}. ${title}${title ? ' — ' : ''}${url}`);
    });
  }
  return lines.join('\n');
}

const schema = { type: 'object', additionalProperties: true };
const text   = (s) => [{ type: 'text', text: s }];

// ── Tool builders ────────────────────────────────────────────────────────
function buildTools(apiKey, config) {
  const tools = [];
  const dNum   = config.defaultNumResults ?? 8;
  const dType  = config.defaultType ?? 'auto';
  const tOut   = config.requestTimeoutMs ?? 30000;

  // ── exa_search ─────────────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'exa_search',
    description:
      'Semantic web search via Exa. Use when keyword search would miss concept-level ' +
      'matches (finding pages about a topic, not pages that contain an exact string). ' +
      'Returns titles, URLs, optional snippets, summaries, and highlights. `type`: ' +
      '"neural" | "keyword" | "auto" (default "auto"). `category` is a vertical filter ' +
      '("company", "research paper", "news", "tweet", "personal site", etc.).',
    parameters: {
      query:               { type: 'string',  required: true, description: 'Natural-language query.' },
      numResults:          { type: 'number',                  description: `1-20, default ${dNum}.` },
      type:                { type: 'string',  enum: ['neural', 'keyword', 'auto'], description: `Search mode (default "${dType}").` },
      category:            { type: 'string',                  description: 'Vertical category filter.' },
      includeText:         { type: 'boolean',                 description: 'Return page text (default true).' },
      includeSummary:      { type: 'boolean',                 description: 'Per-result 1-sentence summary.' },
      startPublishedDate:  { type: 'string',                  description: 'Filter ISO date (YYYY-MM-DD).' },
      useAutoprompt:       { type: 'boolean',                 description: 'Let Exa rewrite the query (default false).' },
    },
    output: { schema, render: (_a, v) => text(renderResults(v.results)) },
    execute: async (args) => {
      const contents = { text: args.includeText ?? true };
      if (args.includeSummary) contents.summary = true;
      const body = {
        query: args.query,
        numResults: Math.min(Math.max(args.numResults ?? dNum, 1), 20),
        type: args.type ?? dType,
        contents,
      };
      if (args.category) body.category = args.category;
      if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
      if (typeof args.useAutoprompt === 'boolean') body.useAutoprompt = args.useAutoprompt;
      const data = await exa('/search', body, apiKey, tOut);
      return { results: data.results ?? [] };
    },
    timeoutMs: tOut + 5000,
  }));

  // ── exa_find_similar ───────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'exa_find_similar',
    description:
      'Given a URL, return semantically similar pages. Use to expand from a known ' +
      'good source or map a topic neighborhood.',
    parameters: {
      url:                 { type: 'string',  required: true, description: 'Seed URL.' },
      numResults:          { type: 'number',                  description: `1-20, default ${dNum}.` },
      excludeSourceDomain: { type: 'boolean',                 description: 'Drop seed domain (default true).' },
      includeSummary:      { type: 'boolean',                 description: 'Per-result 1-sentence summary.' },
    },
    output: { schema, render: (_a, v) => text(renderResults(v.results)) },
    execute: async (args) => {
      const contents = { text: true };
      if (args.includeSummary) contents.summary = true;
      const data = await exa('/findSimilar', {
        url,
        numResults: Math.min(Math.max(args.numResults ?? dNum, 1), 20),
        excludeSourceDomain: args.excludeSourceDomain ?? true,
        contents,
      }, apiKey, tOut);
      return { results: data.results ?? [] };
    },
    timeoutMs: tOut + 5000,
  }));

  // ── exa_get_contents ───────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'exa_get_contents',
    description:
      'Fetch full cleaned text (and optional highlights/summary) from one or more ' +
      'URLs. Use when you already have URLs and want the actual page content.',
    parameters: {
      urls:               { type: 'array', items: { type: 'string' }, required: true, description: 'List of URLs to fetch.' },
      includeSummary:     { type: 'boolean', description: '1-sentence summary per page.' },
      includeHighlights:  { type: 'boolean', description: 'Snippet highlights (default true).' },
      maxCharacters:      { type: 'number',  description: 'Cap per-page text (default 3000).' },
    },
    output: { schema, render: (_a, v) => text(renderResults(v.results)) },
    execute: async (args) => {
      const body = {
        urls: args.urls,
        text: { maxCharacters: args.maxCharacters ?? 3000 },
      };
      if (args.includeSummary)    body.summary    = true;
      if (args.includeHighlights ?? true) body.highlights = true;
      const data = await exa('/contents', body, apiKey, tOut);
      return { results: data.results ?? [] };
    },
    timeoutMs: tOut + 5000,
  }));

  // ── exa_answer ─────────────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'exa_answer',
    description:
      'Question-answering over the live web: Exa searches, reads, and synthesizes ' +
      'a short answer with citations. Use for factual lookups the model is unsure ' +
      'about, or for fresh info beyond the training cutoff.',
    parameters: {
      query:      { type: 'string', required: true, description: 'Question.' },
      numResults: { type: 'number',                 description: `Sources to ground on (1-20, default ${dNum}).` },
    },
    output: { schema, render: (_a, v) => text(renderAnswer(v)) },
    execute: async (args) => {
      const data = await exa('/answer', {
        query: args.query,
        numResults: Math.min(Math.max(args.numResults ?? dNum, 1), 20),
      }, apiKey, tOut * 2);
      return data; // { answer, citations }
    },
    timeoutMs: tOut * 2 + 5000,
  }));

  return tools;
}

// ── API key resolution ───────────────────────────────────────────────────
async function resolveApiKey(ctx, config) {
  // Cordis does not always pass `config` to apply() — at boot, before the
  // settings service has read any user layer, it is undefined. Fall back to
  // an empty object so every field below reads via optional chaining.
  const c = config ?? {};
  if (c.apiKey && c.apiKey.length > 0) {
    return { key: c.apiKey, source: 'settings.apiKey' };
  }
  const ref = credentialRef(c.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
  const creds = ctx.get('credentials');
  if (creds) {
    try {
      const resolved = await creds.resolve(ref);
      if (resolved?.value) return { key: resolved.value, source: `credentials:${ref}` };
    } catch { /* fall through */ }
  }
  const ambient = launchEnvironmentOf(ctx).get(ref);
  if (ambient?.value && ambient.value.length > 0) {
    return { key: ambient.value, source: `env:${ref}` };
  }
  return { key: undefined, source: null };
}

// ── Plugin apply ─────────────────────────────────────────────────────────
export function apply(ctx, config) {
  // Boot phase: cordis calls apply(ctx) without a second argument. Treat
  // undefined config as "no entry" and let installSection own the entry
  // lifecycle through its setSource hook.
  const entry = config;
  let current = () => entry;

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
      setSource: (source) => { current = source; },
      onChange: () => {},
    });
  });

  (async () => {
    const { key, source } = await resolveApiKey(ctx, current());
    if (!key) {
      const cfg = current() ?? {};
      const msg =
        '[dsh-exa] no API key resolved. ' +
        `Open Settings → dsh-exa and paste your Exa key, or set $${cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV} ` +
        'in the launching shell.';
      // ctx.logger.error is a prototype method — must be invoked through the
      // proxy (so `this` is the LoggerService), not detached and called.
      if (ctx.logger) ctx.logger.error(msg);
      else console.error(msg);
      return;
    }
    console.log(`[dsh-exa] using API key from ${source}`);
    for (const tool of buildTools(key, current())) {
      ctx.tools.register(tool);
    }
    console.log('[dsh-exa] registered 4 tools: exa_search, exa_find_similar, exa_get_contents, exa_answer');
  })();
}
