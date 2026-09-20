/**
 * dsh-exa — Exa neural search as a DSH tool.
 *
 * Tools exposed (all read EXA_API_KEY from the host process env):
 *   - exa_search        semantic/keyword web search with optional content
 *   - exa_find_similar  pages similar to a given URL
 *   - exa_get_contents  fetch + summarize text from one or more URLs
 *   - exa_answer        Q&A over the live web with citations
 *
 * Auth: set EXA_API_KEY in your shell env before `dsh web`. The plugin will
 * refuse to register the tools otherwise.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const EXA_BASE = 'https://api.exa.ai';

export const name = 'dsh-exa';
export const inject = ['tools'];

// ── HTTP helper ──────────────────────────────────────────────────────────
async function exa(path, body, apiKey) {
  const res = await fetch(`${EXA_BASE}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'x-exa-integration': 'dsh-exa/0.1.0',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Exa ${path} ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
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

function buildTools(apiKey) {
  const tools = [];

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
      numResults:          { type: 'number',                  description: '1-20, default 8.' },
      type:                { type: 'string',  enum: ['neural', 'keyword', 'auto'], description: 'Search mode.' },
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
        numResults: Math.min(Math.max(args.numResults ?? 8, 1), 20),
        type: args.type ?? 'auto',
        contents,
      };
      if (args.category) body.category = args.category;
      if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
      if (typeof args.useAutoprompt === 'boolean') body.useAutoprompt = args.useAutoprompt;
      const data = await exa('/search', body, apiKey);
      return { results: data.results ?? [] };
    },
    timeoutMs: 30000,
  }));

  // ── exa_find_similar ───────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'exa_find_similar',
    description:
      'Given a URL, return semantically similar pages. Use to expand from a known ' +
      'good source or map a topic neighborhood.',
    parameters: {
      url:                 { type: 'string',  required: true, description: 'Seed URL.' },
      numResults:          { type: 'number',                  description: '1-20, default 8.' },
      excludeSourceDomain: { type: 'boolean',                 description: 'Drop seed domain (default true).' },
      includeSummary:      { type: 'boolean',                 description: 'Per-result 1-sentence summary.' },
    },
    output: { schema, render: (_a, v) => text(renderResults(v.results)) },
    execute: async (args) => {
      const contents = { text: true };
      if (args.includeSummary) contents.summary = true;
      const data = await exa('/findSimilar', {
        url,
        numResults: Math.min(Math.max(args.numResults ?? 8, 1), 20),
        excludeSourceDomain: args.excludeSourceDomain ?? true,
        contents,
      }, apiKey);
      return { results: data.results ?? [] };
    },
    timeoutMs: 30000,
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
      const data = await exa('/contents', body, apiKey);
      return { results: data.results ?? [] };
    },
    timeoutMs: 30000,
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
      numResults: { type: 'number',                 description: 'Sources to ground on (1-20, default 8).' },
    },
    output: { schema, render: (_a, v) => text(renderAnswer(v)) },
    execute: async (args) => {
      const data = await exa('/answer', {
        query: args.query,
        numResults: Math.min(Math.max(args.numResults ?? 8, 1), 20),
      }, apiKey);
      return data; // { answer, citations }
    },
    timeoutMs: 60000,
  }));

  return tools;
}

// ── Plugin apply ─────────────────────────────────────────────────────────
export function apply(ctx) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    (ctx.logger?.error ?? console.error)(
      '[dsh-exa] EXA_API_KEY not set — tools NOT registered. ' +
      'Export it in your shell before launching `dsh web`.'
    );
    return;
  }
  for (const tool of buildTools(apiKey)) {
    ctx.tools.register(tool);
  }
  console.log('[dsh-exa] registered 4 tools: exa_search, exa_find_similar, exa_get_contents, exa_answer');
}
