// Typst (https://typst.app) for highlight.js, which has no built-in grammar for it.
// Covers markup (headings, strong, emphasis, raw, labels, references, math) and the #-code layer.
import type { HLJSApi, Language } from 'highlight.js';

export default function typst(hljs: HLJSApi): Language {
  const KEYWORDS = ['let', 'set', 'show', 'if', 'else', 'for', 'in', 'while', 'break', 'continue', 'return', 'import', 'include', 'as', 'context', 'and', 'or', 'not'];
  const LITERALS = ['none', 'auto', 'true', 'false'];

  const STRING = { scope: 'string', begin: '"', end: '"', contains: [hljs.BACKSLASH_ESCAPE] };
  const NUMBER = { scope: 'number', match: /\b\d+(\.\d+)?(pt|mm|cm|in|em|fr|deg|rad|%)?\b/ };
  const COMMENTS = [hljs.C_LINE_COMMENT_MODE, hljs.C_BLOCK_COMMENT_MODE];

  // `#keyword`, `#func(...)` / `#func[...]`, and plain `#variable`.
  const HASH_KEYWORD = { scope: 'keyword', match: new RegExp(`#(${KEYWORDS.join('|')})\\b`) };
  const HASH_LITERAL = { scope: 'literal', match: new RegExp(`#(${LITERALS.join('|')})\\b`) };
  const HASH_CALL = { scope: 'title.function', match: /#[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*(?=[(\[])/ };
  const HASH_VAR = { scope: 'variable', match: /#[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*/ };

  return {
    name: 'Typst',
    aliases: ['typ'],
    keywords: { keyword: KEYWORDS, literal: LITERALS },
    contains: [
      ...COMMENTS,
      HASH_KEYWORD,
      HASH_LITERAL,
      HASH_CALL,
      HASH_VAR,
      { scope: 'section', begin: /^\s*=+\s/, end: /$/ }, // = Heading
      { scope: 'strong', begin: /(?<![\w*])\*(?=\S)/, end: /\*/ },
      { scope: 'emphasis', begin: /(?<![\w_])_(?=\S)/, end: /_/ },
      { scope: 'code', begin: /```/, end: /```/ },
      { scope: 'code', begin: /`/, end: /`/ },
      { scope: 'formula', begin: /\$/, end: /\$/, contains: [hljs.BACKSLASH_ESCAPE] },
      { scope: 'symbol', match: /<[\w:.-]+>/ }, // <label>
      { scope: 'link', match: /@[\w:.-]+/ }, // @reference
      { scope: 'bullet', match: /^\s*([-+]|\d+\.)\s/ },
      STRING,
      NUMBER,
    ],
  };
}
