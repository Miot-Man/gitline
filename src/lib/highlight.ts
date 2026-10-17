// Syntax highlighting for diff lines. Every highlight.js language is available, but each one is only
// loaded the first time a file needs it. Users can pick the language per file type (see Settings).
import hljs from 'highlight.js/lib/core';
import { LANGUAGE_NAMES } from './languageNames';

type LangModule = { default: Parameters<typeof hljs.registerLanguage>[1] };

// One lazily loaded chunk per language, keyed by highlight.js's id ("cpp", "lua", ...).
// Languages highlight.js doesn't ship are written here, in ./languages.
const CUSTOM: Record<string, { name: string; load: () => Promise<LangModule> }> = {
  typst: { name: 'Typst', load: () => import('./languages/typst') as Promise<LangModule> },
};
const LOADERS: Record<string, () => Promise<LangModule>> = {
  ...Object.fromEntries(
    Object.entries(import.meta.glob<LangModule>('../../node_modules/highlight.js/es/languages/*.js'))
      .filter(([file]) => !file.endsWith('.js.js'))
      .map(([file, load]) => [file.split('/').pop()!.replace(/\.js$/, ''), load])
  ),
  ...Object.fromEntries(Object.entries(CUSTOM).map(([id, c]) => [id, c.load])),
};

export const displayName = (id: string) => CUSTOM[id]?.name ?? LANGUAGE_NAMES[id] ?? id;

// Every language a user can pick, sorted by display name.
export const LANGUAGES = Object.keys(LOADERS)
  .map((id) => ({ id, name: displayName(id) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const loading = new Map<string, Promise<boolean>>();

export const isLoaded = (id: string) => !!hljs.getLanguage(id);

export function loadLanguage(id: string): Promise<boolean> {
  if (isLoaded(id)) return Promise.resolve(true);
  if (!LOADERS[id]) return Promise.resolve(false);
  if (!loading.has(id)) {
    loading.set(
      id,
      LOADERS[id]()
        .then((m) => {
          hljs.registerLanguage(id, m.default);
          return true;
        })
        .catch(() => false)
    );
  }
  return loading.get(id)!;
}

// Built-in guesses from the file extension; users can override any of them.
const BY_EXT: Record<string, string> = {
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  ino: 'arduino', pde: 'arduino',
  cs: 'csharp', fs: 'fsharp',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  go: 'go', rs: 'rust', zig: 'c',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'gradle', clj: 'clojure',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown', tex: 'latex', typ: 'typst', rst: 'plaintext',
  php: 'php', py: 'python', pyw: 'python', rb: 'ruby', pl: 'perl', lua: 'lua', r: 'r', jl: 'julia',
  dart: 'dart', swift: 'swift', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', nim: 'nim',
  v: 'verilog', sv: 'verilog', vh: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', nix: 'nix',
  ps1: 'powershell', psm1: 'powershell', bat: 'dos', cmd: 'dos',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', xaml: 'xml', csproj: 'xml',
  yml: 'yaml', yaml: 'yaml',
  cmake: 'cmake', mk: 'makefile', diff: 'diff', patch: 'diff',
};

const BY_NAME: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  dockerfile: 'dockerfile',
  'nginx.conf': 'nginx',
  '.gitignore': 'bash',
  '.env': 'bash',
};

// A user's choice for a file type: `pattern` is an extension (".ino") or an exact file name ("Makefile").
// `language` is a highlight.js id, or "none" for plain text.
export interface LanguageRule {
  pattern: string;
  language: string;
}

export const PLAIN = 'none';

// The pattern a choice made on this file is remembered under: its extension, or its name if it has none.
export function patternFor(path: string) {
  const name = path.split('/').pop()!;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : name;
}

// What Gitline would pick for this file without any user rules.
export function guessLanguage(path: string): string | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? BY_EXT[name.slice(dot + 1)] ?? null : null;
}

export function languageFor(path: string, rules: LanguageRule[] = []): string | null {
  const name = path.split('/').pop()!.toLowerCase();
  const ext = patternFor(path).toLowerCase();
  const rule = rules.find((r) => r.pattern.toLowerCase() === name) ?? rules.find((r) => r.pattern.toLowerCase() === ext);
  if (rule) return rule.language === PLAIN ? null : rule.language;
  return guessLanguage(path);
}

// Splits highlighted HTML at newlines. A span still open at a line break (a docstring, a block comment)
// is closed at the end of that line and reopened on the next, so every line is valid HTML on its own.
export function splitHtmlLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = '';
  for (const m of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else if (m[3]) {
      out.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else cur += m[4];
  }
  out.push(cur);
  return out;
}

// Highlights consecutive lines as one text, so constructs spanning lines are coloured correctly.
export function highlightLines(lines: string[], lang: string | null): string[] {
  if (!lang || !isLoaded(lang)) return lines.map(escapeHtml);
  return splitHtmlLines(hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value);
}

// Wraps character ranges [start, end) of the original text in <span class="wd"> inside highlighted HTML.
// The mark is closed at other tags and reopened after them, so the nesting stays valid.
export function markRanges(html: string, ranges: [number, number][]): string {
  if (!ranges.length) return html;
  let out = '';
  let pos = 0;
  let marked = false;
  for (const m of html.matchAll(/(<[^>]+>)|(&[#\w]+;|[^<&])/g)) {
    if (m[1]) {
      // Close the mark before any other tag; the next character reopens it if it's still in a range.
      if (marked) out += '</span>';
      marked = false;
      out += m[1];
      continue;
    }
    const want = ranges.some(([a, b]) => pos >= a && pos < b);
    if (want !== marked) out += want ? '<span class="wd">' : '</span>';
    marked = want;
    out += m[2];
    pos++;
  }
  return marked ? out + '</span>' : out;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Returns HTML; highlight.js escapes the source text. Falls back to plain (escaped) text until the
// language has loaded.
export function highlight(text: string, lang: string): string {
  if (!isLoaded(lang)) return escapeHtml(text);
  return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
}
