// parse.js — a fast Markdown → HTML renderer whose output is byte-for-byte
// identical to marked 18.1.3 running with its default options
// (gfm: true, breaks: false, pedantic: false, async: false).
//
// Written from scratch as a single-pass scanner: a block phase walks the
// document line by line producing block tokens (collecting link reference
// definitions on the way), then a queued inline phase resolves emphasis,
// links, code spans and friends, and a render phase emits the final HTML.
// No dependencies; only Node built-ins are used (in fact, none at all).
//
// The rendering contract implemented here:
//   parse(markdown: string): string  — the exact HTML marked would produce.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape HTML. With `encode`, existing entities are encoded too. */
function escapeHtml(text, encode) {
  if (encode) {
    if (escapeTest.test(text)) return text.replace(escapeReplace, ch => ESCAPES[ch]);
  } else if (escapeTestNoEncode.test(text)) {
    return text.replace(escapeReplaceNoEncode, ch => ESCAPES[ch]);
  }
  return text;
}

const numericRefTest = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefReplace = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/**
 * Decode numeric character references in a run of plain text; a bare
 * ampersand that is not part of a reference becomes &amp; and an invalid
 * code point becomes U+FFFD. Named entities are left untouched.
 */
function decodeText(text) {
  if (!numericRefTest.test(text)) return text;
  return text.replace(numericRefReplace, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '�';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/** encodeURI with %25 folded back to %, or null when the URL is unusable. */
function cleanUrl(url) {
  try {
    return encodeURI(url).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Remove trailing copies of `ch` (used for raw-token bookkeeping). */
function rtrimChars(text, ch) {
  const n = text.length;
  if (n === 0) return '';
  let count = 0;
  while (count < n && text.charAt(n - count - 1) === ch) count++;
  return count === 0 ? text : text.slice(0, n - count);
}

const blankLineRe = /^[ \t]*$/;

/** Drop trailing blank lines when there are more than two of them. */
function trimBlankTail(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && blankLineRe.test(lines[last])) last--;
  return lines.length - last <= 2 ? text : lines.slice(0, last + 1).join('\n');
}

/** Expand tabs to spaces on a 4-column grid starting at column `startCol`. */
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/** Normalize a link reference label for use as a lookup key. */
function normalizeRef(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/**
 * Find an unmatched closing bracket: -1 when the brackets balance (or none
 * occur), the index of an extra closer, or -2 when an opener never closes.
 * Backslash-escaped characters are skipped.
 */
function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

/**
 * Split a table row into cells on unescaped pipes, honouring the same
 * quirks as the reference: a pipe becomes a separator only in the exact
 * " |" form after rewriting, edge cells that are blank are dropped, and
 * the row is padded/truncated to `count` cells when a count is given.
 */
function splitCells(str, count) {
  const rewritten = str.replace(/\|/g, (match, offset, whole) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && whole[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = rewritten.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Rule tables (GFM flavour). These patterns encode the grammar the renderer
// implements: block structure first, then the inline grammar.
// ---------------------------------------------------------------------------

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const block = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  text: /^[^\n]+/,
};

const inline = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
};

// Patterns used by the block phase for one-off tests.
const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  outputLinkReplace: /\\([\[\]])/g,
};

// Indent-sensitive "does a block of kind X start here" probes used while
// scanning list items. The reference implementation derives them from the
// item indent clamped into a small range; the four variants are prebuilt.
const indentProbes = [0, 1, 2, 3].map(n => ({
  nextBullet: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
  hr: new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
  fencesBegin: new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
  headingBegin: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
  htmlBegin: new RegExp(`^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  blockquoteBegin: new RegExp(`^ {0,${n}}>`),
}));
function probesFor(indent) {
  return indentProbes[Math.max(0, Math.min(3, indent - 1))];
}
function listItemPattern(bulletPattern) {
  return new RegExp(`^( {0,3}${bulletPattern})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
}

// ---------------------------------------------------------------------------
// Emphasis masking. Before inline scanning, a masked copy of the source is
// built where link destinations, code spans and escapes are neutralised, so
// the delimiter-run searches cannot be fooled by delimiters hiding inside
// them. Masking preserves length, so indices line up with the real source.
// ---------------------------------------------------------------------------

/**
 * Scan a (masked) string for the last position where an emphasis or
 * strikethrough closer could still occur: a run of the delimiter whose
 * preceding character is not blank.
 */
function scanDelimiters(maskedSrc) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = maskedSrc.length;
  for (let s = 0; s < n; s++) {
    const ch = maskedSrc[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : maskedSrc[s - 1];
    let i = s + 1;
    while (i < n && maskedSrc[i] === ch) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = s;
      else lastEm[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc, lastEm, lastDel };
}

function lastEmCloser(ctx, masked, delim) {
  const top = ctx.maskStack[ctx.maskStack.length - 1];
  return top && top.maskedSrc === masked ? top.lastEm[delim] : scanDelimiters(masked).lastEm[delim];
}
function lastDelCloser(ctx, masked) {
  const top = ctx.maskStack[ctx.maskStack.length - 1];
  return top && top.maskedSrc === masked ? top.lastDel : scanDelimiters(masked).lastDel;
}

/** Does this text contain something that resolves to a link? */
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(inline.blockSkip)) {
    if (inline.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(inline.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeRef(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(ctx, s.slice(1, r - 1)))) return true;
  }
  return false;
}

/** Build the masked twin of an inline source string. */
function maskSource(ctx, src) {
  let t = src;
  if (src.includes('[')) {
    const maskRef = r => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeRef(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(ctx, inner)) {
          return '[' + inner.replace(inline.reflinkSearch, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(inline.reflinkSearch, maskRef);
  }
  // Each masking pass is skipped when none of its trigger characters is
  // present (the replacement would be the identity).
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(inline.anyPunctuationOutsideCode, (whole, ticks, punct) =>
      punct ? '+'.repeat(whole.length)
        : ticks ? ticks + whole.slice(ticks.length, whole.length - ticks.length).replace(/`/g, '+') + ticks
          : whole);
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(inline.blockSkip, whole => '[' + 'a'.repeat(whole.length - 2) + ']');
  }
  return t;
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes the remaining source and returns a token or
// undefined. `ctx` carries the document state: link definitions, the inline
// queue, the mask stack and the mutable state flags.
// ---------------------------------------------------------------------------

function queueInline(ctx, src) {
  const tokens = [];
  ctx.queue.push({ src, tokens });
  return tokens;
}

function tokEscape(src) {
  const m = inline.escape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
}

function tokTag(ctx, src) {
  const m = inline.tag.exec(src);
  if (!m) return;
  if (!ctx.state.inLink && other.startATag.test(m[0])) ctx.state.inLink = true;
  else if (ctx.state.inLink && other.endATag.test(m[0])) ctx.state.inLink = false;
  if (!ctx.state.inRawBlock && other.startPreScriptTag.test(m[0])) ctx.state.inRawBlock = true;
  else if (ctx.state.inRawBlock && other.endPreScriptTag.test(m[0])) ctx.state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: ctx.state.inLink, inRawBlock: ctx.state.inRawBlock, block: false, text: m[0] };
}

/**
 * A link label hides an unclosed tag (or a tag that would swallow the
 * closing bracket) — in that case the bracket is not a link at all.
 */
function labelHidesTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = inline.code.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const m = inline.tag.exec(src.slice(offset + s)) || inline.autolink.exec(src.slice(offset + s));
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

/** Shared tail of link / image / reference-link construction. */
function finishLink(ctx, cap, def, raw) {
  const href = def.href;
  const title = def.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = ctx.state.inLink;
  const savedEmitted = ctx.state.linkEmitted;
  const savedRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const tokens = inlineTokens(ctx, text, []);
  const emitted = ctx.state.linkEmitted;
  ctx.state.linkEmitted = savedEmitted;
  ctx.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.state.inRawBlock = savedRawBlock;
      return undefined;
    }
    ctx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokLink(ctx, src) {
  if (ctx.state.linkParenPossible === false) return;
  const cap = inline.link.exec(src);
  if (!cap) return;
  if (labelHidesTag(src, cap[1], cap[0].charAt(0) === '!' ? 2 : 1)) return;
  const trimmedHref = cap[2].trim();
  if (other.startAngleBracket.test(trimmedHref)) {
    if (!other.endAngleBracket.test(trimmedHref)) return;
    const stripped = rtrimChars(trimmedHref.slice(0, -1), '\\');
    if ((trimmedHref.length - stripped.length) % 2 === 0) return;
  } else {
    const close = findClosingBracket(cap[2], '()');
    if (close === -2) return;
    if (close > -1) {
      const end = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + close;
      cap[2] = cap[2].substring(0, close);
      cap[0] = cap[0].substring(0, end).trim();
      cap[3] = '';
    }
  }
  const tail = rtrimChars(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - tail.length) % 2 === 0) return;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
  return finishLink(ctx, cap, {
    href: href && href.replace(inline.anyPunctuation, '$1'),
    title: title && title.replace(inline.anyPunctuation, '$1'),
  }, cap[0]);
}

function tokReflink(ctx, src) {
  let cap;
  if ((cap = inline.reflink.exec(src)) || (cap = inline.nolink.exec(src))) {
    if (labelHidesTag(src, cap[1], cap[0].charAt(0) === '!' ? 2 : 1)) return;
    const def = ctx.links[normalizeRef(cap[2] || cap[1])];
    if (!def) {
      const first = cap[0].charAt(0);
      return { type: 'text', raw: first, text: first };
    }
    return finishLink(ctx, cap, def, cap[0]);
  }
}

function tokEmStrong(ctx, src, masked, prevChar) {
  const cap = inline.emStrongLDelim.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return;
  const delim = cap[0][0];
  const prevIsDelim = prevChar === delim;
  const offset = masked.length - src.length;
  let runStart = offset;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!inline.punctuation.exec(beforeRun);
  let prev = prevChar;
  if (runStart < offset) prev = beforeRun;
  const prevIsPunct = runStart < offset ? beforeIsPunct : !!inline.punctuation.exec(prev);
  if (cap[4] && prev.match(other.unicodeAlphaNumeric)) return;
  const punctAfter = cap[1] || cap[3] || '';
  if (!punctAfter || !prev || prevIsPunct) {
    const openLen = [...cap[0]].length - 1;
    let remaining = openLen;
    let fudge = 0;
    const combinedRun = offset - runStart + openLen;
    const canAlsoClose = !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsPunct));
    const closerRe = delim === '*' ? inline.emStrongRDelimAst : inline.emStrongRDelimUnd;
    const lastCloser = lastEmCloser(ctx, masked, delim);
    const afterOpen = offset + openLen;
    if (lastCloser < afterOpen) return;
    const rest = masked.slice(afterOpen);
    const maxIndex = lastCloser - afterOpen;
    let match;
    closerRe.lastIndex = 0;
    while ((match = closerRe.exec(rest)) !== null && !(match.index > maxIndex)) {
      const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (match[3] || match[4]) { remaining += runLen; continue; }
      if (match[5] || match[6] || canAlsoClose) {
        if (prevIsDelim && (match[5] || match[6])) break;
        if (combinedRun % 3 && !((combinedRun + runLen) % 3)) { fudge += runLen; continue; }
      }
      remaining -= runLen;
      if (remaining > 0) continue;
      runLen = Math.min(runLen, runLen + remaining + fudge);
      const firstCpLen = [...match[0]][0].length;
      const raw = src.slice(0, openLen + match.index + firstCpLen + runLen);
      if (Math.min(openLen, runLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(ctx, text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(ctx, text, []) };
    }
  }
}

function tokDel(ctx, src, masked, prevChar) {
  const cap = inline.delLDelim.exec(src);
  if (!cap) return;
  if (!(cap[1] || '') || !prevChar || inline.punctuation.exec(prevChar)) {
    const openLen = [...cap[0]].length - 1;
    let remaining = openLen;
    const lastCloser = lastDelCloser(ctx, masked);
    const afterOpen = masked.length - src.length + openLen;
    if (lastCloser < afterOpen) return;
    const rest = masked.slice(afterOpen);
    const maxIndex = lastCloser - afterOpen;
    let match;
    inline.delRDelim.lastIndex = 0;
    while ((match = inline.delRDelim.exec(rest)) !== null && !(match.index > maxIndex)) {
      const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (runLen !== openLen) continue;
      if (match[3] || match[4]) { remaining += runLen; continue; }
      remaining -= runLen;
      if (remaining > 0) continue;
      runLen = Math.min(runLen, runLen + remaining);
      const firstCpLen = [...match[0]][0].length;
      const raw = src.slice(0, openLen + match.index + firstCpLen + runLen);
      const text = raw.slice(openLen, -openLen);
      return { type: 'del', raw, text, tokens: inlineTokens(ctx, text, []) };
    }
  }
}

function tokCodespan(src) {
  const cap = inline.code.exec(src);
  if (!cap) return;
  let text = cap[2].replace(/\n/g, ' ');
  const hasNonSpace = /[^ ]/.test(text);
  if (hasNonSpace && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: cap[0], text };
}

function tokBr(src) {
  const cap = inline.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function tokAutolink(src) {
  const cap = inline.autolink.exec(src);
  if (!cap) return;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokUrl(src) {
  const cap = inline.url.exec(src);
  if (!cap) return;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let before;
    do {
      before = cap[0];
      cap[0] = inline._backpedal.exec(cap[0])?.[0] ?? '';
    } while (before !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokInlineText(ctx, src) {
  const cap = inline.text.exec(src);
  if (!cap) return;
  const inRaw = ctx.state.inRawBlock;
  return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : decodeText(cap[0]), escaped: inRaw };
}

/**
 * Tokenize one inline string. The public wrapper maintains the
 * linkParenPossible invariant across nested calls (link labels).
 */
function inlineTokens(ctx, src, tokens) {
  const saved = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = saved && src.includes(')');
  try {
    return inlineTokensMain(ctx, src, tokens);
  } finally {
    ctx.state.linkParenPossible = saved;
  }
}

function inlineTokensMain(ctx, src, tokens) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskSource(ctx, src) : src;
  ctx.maskStack.push(scanDelimiters(masked));
  try {
    return inlineLoop(ctx, src, masked, tokens);
  } finally {
    ctx.maskStack.pop();
  }
}

function inlineLoop(ctx, src, masked, tokens) {
  let prevChar = '';
  let prevWasText = false;
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0) + '\nPlease report this to https://github.com/markedjs/marked.');
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    let tok;
    // Dispatch on the first character: each bucket tries, in the
    // reference order, only the tokenizers whose pattern can start
    // with that character. Everything else falls through to text.
    const c = src.charCodeAt(0);
    if (c === 92) { // backslash: escape, br
      if (tok = tokEscape(src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (tok = tokBr(src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 60) { // <: tag, autolink
      if (tok = tokTag(ctx, src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (tok = tokAutolink(src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 33) { // !: link, reflink, url
      if (tok = tokLink(ctx, src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (tok = tokReflink(ctx, src)) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.type === 'text' && last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if (!ctx.state.inLink && (tok = tokUrl(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 91) { // [: link, reflink
      if (tok = tokLink(ctx, src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (tok = tokReflink(ctx, src)) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.type === 'text' && last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
    } else if (c === 42 || c === 95) { // * or _: emStrong, url
      if (tok = tokEmStrong(ctx, src, masked, prevChar)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!ctx.state.inLink && (tok = tokUrl(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 96) { // backtick: codespan, url
      if (tok = tokCodespan(src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!ctx.state.inLink && (tok = tokUrl(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 126) { // ~: del, url
      if (tok = tokDel(ctx, src, masked, prevChar)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!ctx.state.inLink && (tok = tokUrl(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 32) { // space: br
      if (tok = tokBr(src)) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c !== 10) { // anything else except newline: url
      if (!ctx.state.inLink && (tok = tokUrl(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    }
    if (tok = tokInlineText(ctx, src)) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      prevWasText = true;
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += tok.raw;
        last.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0) + '\nPlease report this to https://github.com/markedjs/marked.');
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers
// ---------------------------------------------------------------------------

function tokSpace(src) {
  const m = block.newline.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
}

function tokCodeBlock(src) {
  const m = block.code.exec(src);
  if (!m) return;
  const raw = trimBlankTail(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(other.codeRemoveIndent, '') };
}

/** Remove the fence indent from fenced code content, when it applies. */
function fenceText(raw, content) {
  const m = raw.match(other.indentCodeCompensation);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map(line => {
    const lead = line.match(other.beginningSpace);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

function tokFences(src) {
  const m = block.fences.exec(src);
  if (!m) return;
  return {
    type: 'code',
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(inline.anyPunctuation, '$1') : m[2],
    text: fenceText(m[0], m[3] || ''),
  };
}

function tokHeading(ctx, src) {
  const m = block.heading.exec(src);
  if (!m) return;
  let text = m[2].trim();
  if (other.endingHash.test(text)) {
    const stripped = rtrimChars(text, '#');
    if (!stripped || other.endingSpaceTabChar.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: rtrimChars(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(ctx, text) };
}

function tokHr(src) {
  const m = block.hr.exec(src);
  if (m) return { type: 'hr', raw: rtrimChars(m[0], '\n') };
}

function tokBlockquote(ctx, src) {
  const m = block.blockquote.exec(src);
  if (!m) return;
  let rest = rtrimChars(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (rest.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < rest.length; p++) {
      if (other.blockquoteStart.test(rest[p])) {
        chunk.push(rest[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(rest[p]);
      } else break;
    }
    rest = rest.slice(p);
    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      .replace(other.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + chunkText : chunkText;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    blockTokens(ctx, chunkText, tokens, true);
    ctx.state.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const joined = last.raw + '\n' + rest.join('\n').replace(other.blockquoteSetextReplace2, '');
      const requoted = tokBlockquote(ctx, joined);
      tokens[tokens.length - 1] = requoted;
      const leftover = joined.substring(requoted.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines ? rest.slice(0, -leftoverLines) : rest;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + requoted.text;
      rest = rest.slice(consumed.length);
      if (rest.length > 0 && other.blockquoteStart.test(rest[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const joined = last.raw + '\n' + rest.join('\n');
      const relisted = tokList(ctx, joined);
      tokens[tokens.length - 1] = relisted;
      const extra = relisted.raw.length > last.raw.length
        ? joined.slice(last.raw.length + 1, relisted.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const taken = rest.slice(0, extra).join('\n');
        raw += '\n' + taken;
        text += '\n' + taken;
      }
      rest = rest.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

/** Whether `s` ends with a blank line (the doubleBlankLine test). */
function endsWithDoubleBlank(s) {
  let i = s.length - 1;
  while (i >= 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i--;
  if (i < 0 || s.charCodeAt(i) !== 10) return false;
  i--;
  while (i >= 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i--;
  return i >= 0 && s.charCodeAt(i) === 10;
}

function tokList(ctx, src) {
  const first = block.list.exec(src);
  if (!first) return;
  const original = src;
  let rest = src;
  const consumed = () => original.length - rest.length;
  const bulletText = first[1].trim();
  const ordered = bulletText.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bulletText.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPattern = ordered ? `\\d{1,9}\\${bulletText.slice(-1)}` : `\\${bulletText}`;
  const itemRe = listItemPattern(bulletPattern);
  let pendingBlank = false;
  while (rest) {
    let endsEarly = false;
    let content = '';
    const cap = itemRe.exec(rest);
    if (!cap || block.hr.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(cap[0].length);
    const firstLine = cap[2].endsWith('\n') ? cap[2].slice(0, -1) : cap[2];
    const bulletLen = cap[1].length;
    let lineText = firstLine.replace(other.leadingSpaceTab, v => expandTabs(v, bulletLen));
    const nl0 = rest.indexOf('\n');
    let nextLine = nl0 === -1 ? rest : rest.slice(0, nl0);
    const blankFirst = !lineText.trim();
    let indent = 0;
    if (blankFirst) {
      indent = bulletLen + 1;
    } else {
      indent = lineText.search(other.nonSpaceChar);
      if (indent > 4) indent = 1;
      content = lineText.slice(indent);
      indent += bulletLen;
    }
    if (blankFirst && blankLineRe.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      endsEarly = true;
    }
    if (!endsEarly) {
      const probes = probesFor(indent);
      const bound = Math.max(0, Math.min(indent - 1, 3));
      let wasBlank = blankFirst;
      while (rest) {
        const nl = rest.indexOf('\n');
        const line = nl === -1 ? rest : rest.slice(0, nl);
        nextLine = line;
        // Tab expansion only touches the leading whitespace run; when
        // that run contains no tab the expansion is the identity.
        let expanded = line;
        const c0 = line.charCodeAt(0);
        if (c0 === 32 || c0 === 9) {
          let e = 0;
          let hasTab = false;
          while (e < line.length && (line.charCodeAt(e) === 32 || line.charCodeAt(e) === 9)) {
            if (line.charCodeAt(e) === 9) hasTab = true;
            e++;
          }
          if (hasTab) expanded = line.replace(other.leadingSpaceTab, v => expandTabs(v));
        }
        // The probes can only match when, after at most `bound` spaces,
        // the line continues with a construct character.
        {
          let j = 0;
          while (j < bound && line.charCodeAt(j) === 32) j++;
          const pc = line.charCodeAt(j);
          if (pc === 96 || pc === 126 || pc === 35 || pc === 60 || pc === 62 || pc === 42 ||
              pc === 43 || pc === 45 || pc === 95 || (pc >= 48 && pc <= 57)) {
            if (probes.fencesBegin.test(line) || probes.headingBegin.test(line) || probes.htmlBegin.test(line) ||
                probes.blockquoteBegin.test(line) || probes.nextBullet.test(line) || probes.hr.test(line)) break;
          }
        }
        const firstNonSpace = expanded.search(other.nonSpaceChar);
        if (firstNonSpace >= indent || firstNonSpace === -1) {
          content += '\n' + expanded.slice(indent);
        } else {
          if (wasBlank ||
              lineText.replace(/\t/g, '    ').search(other.nonSpaceChar) >= 4 ||
              probes.fencesBegin.test(lineText) || probes.headingBegin.test(lineText) ||
              probes.htmlBegin.test(lineText) || probes.hr.test(lineText)) break;
          const lazy = /^ {0,3}(?:=+|-+) *$/.test(line) && block.lheading.test(lineText + '\n' + line)
            ? '    ' + expanded.replace(/^ {0,3}/, '')
            : line;
          content += '\n' + lazy;
        }
        wasBlank = firstNonSpace === -1;
        rest = rest.substring(line.length + 1);
        lineText = expanded.slice(indent);
      }
    }
    const itemRaw = original.slice(itemStart, consumed());
    if (!list.loose) {
      if (pendingBlank) list.loose = true;
      else if (endsWithDoubleBlank(itemRaw)) pendingBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: !!other.listIsTask.test(content),
      loose: false,
      text: content,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = original.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = blockTokens(ctx, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter(tok => tok.type === 'space');
      list.loose = spaces.length > 0 && spaces.some(tok => other.anyLine.test(tok.raw));
    }
  }
  for (const item of list.items) {
    const head = item.tokens[0];
    if (item.task && head && (head.type === 'text' || head.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      head.raw = head.raw.replace(other.listReplaceTask, '');
      head.text = head.text.replace(other.listReplaceTask, '');
      for (let g = ctx.queue.length - 1; g >= 0; g--) {
        if (other.listIsTask.test(ctx.queue[g].src)) {
          ctx.queue[g].src = ctx.queue[g].src.replace(other.listReplaceTask, '');
          break;
        }
      }
      const check = other.listTaskCheckbox.exec(item.raw);
      if (check) {
        const checkbox = { type: 'checkbox', raw: check[0] + ' ', checked: check[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          const headNow = item.tokens[0];
          if (headNow && (headNow.type === 'paragraph' || headNow.type === 'text') && 'tokens' in headNow && headNow.tokens) {
            headNow.raw = checkbox.raw + headNow.raw;
            headNow.text = checkbox.raw + headNow.text;
            headNow.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function tokHtmlBlock(src) {
  const m = block.html.exec(src);
  if (!m) return;
  const text = trimBlankTail(m[0]);
  return { type: 'html', block: true, raw: text, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text };
}

function tokDef(src) {
  const m = block.def.exec(src);
  if (!m) return;
  if (!/^</.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return;
  return {
    type: 'def',
    tag: normalizeRef(m[1]),
    raw: rtrimChars(m[0], '\n'),
    href: m[2] ? m[2].replace(other.hrefBrackets, '$1').replace(inline.anyPunctuation, '$1') : '',
    title: m[3] ? m[3].substring(1, m[3].length - 1).replace(inline.anyPunctuation, '$1') : m[3],
  };
}

function tokTable(ctx, src) {
  const m = block.table.exec(src);
  if (!m || !other.tableDelimiter.test(m[2])) return;
  const headerCells = splitCells(m[1]);
  const aligns = m[2].replace(other.tableAlignChars, '').split('|');
  const rowLines = m[3]?.trim() ? m[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== aligns.length) return;
  const table = { type: 'table', raw: rtrimChars(m[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of aligns) {
    table.align.push(
      other.tableAlignRight.test(cell) ? 'right'
        : other.tableAlignCenter.test(cell) ? 'center'
          : other.tableAlignLeft.test(cell) ? 'left' : null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(ctx, headerCells[i]), header: true, align: table.align[i] });
  }
  for (const row of rowLines) {
    table.rows.push(splitCells(row, headerCells.length).map((cellText, j) => ({
      text: cellText, tokens: queueInline(ctx, cellText), header: false, align: table.align[j],
    })));
  }
  return table;
}

function tokLheading(ctx, src) {
  const m = block.lheading.exec(src);
  if (!m) return;
  const text = m[1].trim();
  return { type: 'heading', raw: rtrimChars(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(ctx, text) };
}

function tokParagraph(ctx, src) {
  const m = block.paragraph.exec(src);
  if (!m) return;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(ctx, text) };
}

function tokBlockText(ctx, src) {
  const m = block.text.exec(src);
  if (m) return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(ctx, m[0]) };
}

/**
 * Necessary-condition check for a table: the second line must be a
 * delimiter row (only | : - and spaces, at most three leading spaces,
 * at least one dash and one pipe or colon).
 */
function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let hasContent = false;
  for (let i = 0; i < nl; i++) {
    if (src.charCodeAt(i) !== 32) { hasContent = true; break; }
  }
  if (!hasContent) return false;
  let i = nl + 1;
  let spaces = 0;
  while (src.charCodeAt(i) === 32 && spaces < 4) { i++; spaces++; }
  if (spaces > 3) return false;
  let hasDash = false;
  let hasPipeOrColon = false;
  for (; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 10) break;
    if (c === 45) hasDash = true;
    else if (c === 124 || c === 58) hasPipeOrColon = true;
    else if (c !== 32) return false;
  }
  return hasDash && hasPipeOrColon;
}

const setextUnderlineRe = /^ {0,3}(?:=+|-+)[ \t]*$/;

/**
 * Necessary-condition check for a setext heading: some line in the
 * current non-blank run (after the first) is an underline line.
 */
function hasSetextUnderline(src) {
  let i = src.indexOf('\n');
  if (i === -1) return false;
  i++;
  while (i < src.length) {
    let j = src.indexOf('\n', i);
    if (j === -1) j = src.length;
    if (setextUnderlineRe.test(src.slice(i, j))) return true;
    // a blank line ends the run the heading body could span
    let blank = true;
    for (let k = i; k < j; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank) return false;
    i = j + 1;
  }
  return false;
}

/**
 * The block phase. Walks `src` producing block tokens into `tokens`;
 * inline content is queued on ctx for later resolution (definitions can
 * appear after their uses). `lastBlock` is the blockquote-chunk mode in
 * which a fresh paragraph merges into a trailing one.
 */
function blockTokens(ctx, src, tokens, lastBlock) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0) + '\nPlease report this to https://github.com/markedjs/marked.');
    let tok;
    // First-significant-character gates: most block patterns open with
    // up to three spaces and one specific character, so the others can
    // be skipped without running their patterns.
    let sp = 0;
    while (sp < 4 && src.charCodeAt(sp) === 32) sp++;
    const fc = src.charCodeAt(sp);
    let b = 0;
    while (b < src.length && (src.charCodeAt(b) === 32 || src.charCodeAt(b) === 9)) b++;
    const blankLine = b === src.length || src.charCodeAt(b) === 10;
    if (blankLine && (tok = tokSpace(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((sp === 4 || src.charCodeAt(0) === 9 || (sp < 4 && fc === 9)) && (tok = tokCodeBlock(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if (sp <= 3 && (fc === 96 || fc === 126) && (tok = tokFences(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp <= 3 && fc === 35 && (tok = tokHeading(ctx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp <= 3 && (fc === 42 || fc === 45 || fc === 95) && (tok = tokHr(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp <= 3 && fc === 62 && (tok = tokBlockquote(ctx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp <= 3 && (fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && (tok = tokList(ctx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp <= 3 && fc === 60 && (tok = tokHtmlBlock(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (sp <= 3 && fc === 91 && (tok = tokDef(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        if (!ctx.links[tok.tag]) ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if (tablePossible(src) && (tok = tokTable(ctx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (hasSetextUnderline(src) && (tok = tokLheading(ctx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (ctx.state.top && (tok = tokParagraph(ctx, src))) {
      const last = tokens[tokens.length - 1];
      if (lastBlock && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else tokens.push(tok);
      lastBlock = false;
      src = src.substring(tok.raw.length);
      continue;
    }
    if (tok = tokBlockText(ctx, src)) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0) + '\nPlease report this to https://github.com/markedjs/marked.');
  }
  ctx.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering. Two inline modes: the normal renderer and the plain-text
// renderer used for image alt text.
// ---------------------------------------------------------------------------

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCodeBlock(tok) {
  const langWord = (tok.lang || '').match(/^\S*/)?.[0];
  const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
  const body = escapeHtml(text, true);
  return langWord
    ? '<pre><code class="language-' + escapeHtml(langWord) + '">' + body + '</code></pre>\n'
    : '<pre><code>' + body + '</code></pre>\n';
}

function renderTable(ctx, tok) {
  let headerCells = '';
  for (const cell of tok.header) headerCells += renderTableCell(ctx, cell);
  let out = '<table>\n<thead>\n<tr>\n' + headerCells + '</tr>\n</thead>\n';
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(ctx, cell);
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) out += '<tbody>' + body + '</tbody>';
  return out + '</table>\n';
}

function renderTableCell(ctx, cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) +
    renderInline(ctx, cell.tokens) + `</${tag}>\n`;
}

function renderList(ctx, tok) {
  let body = '';
  for (const item of tok.items) body += '<li>' + renderTokens(ctx, item.tokens) + '</li>\n';
  const tag = tok.ordered ? 'ol' : 'ul';
  const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
  return '<' + tag + start + '>\n' + body + '</' + tag + '>\n';
}

function renderLink(ctx, tok) {
  const inner = tok.autolink ? escapeHtml(tok.text, true) : renderInline(ctx, tok.tokens);
  const clean = cleanUrl(tok.href);
  if (clean === null) return inner;
  let out = '<a href="' + escapeHtml(clean, tok.autolink) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  return out + '>' + inner + '</a>';
}

function renderImage(ctx, tok) {
  const alt = tok.tokens ? renderInlinePlain(ctx, tok.tokens) : tok.text;
  const clean = cleanUrl(tok.href);
  if (clean === null) return escapeHtml(alt);
  let out = '<img src="' + escapeHtml(clean) + '" alt="' + escapeHtml(alt) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  return out + '>';
}

function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return null; // handled by caller (needs ctx)
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderInline(ctx, tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += escapeHtml(tok.text); break;
      case 'html': out += tok.text; break;
      case 'link': out += renderLink(ctx, tok); break;
      case 'image': out += renderImage(ctx, tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'strong': out += '<strong>' + renderInline(ctx, tok.tokens) + '</strong>'; break;
      case 'em': out += '<em>' + renderInline(ctx, tok.tokens) + '</em>'; break;
      case 'codespan': out += '<code>' + escapeHtml(tok.text, true) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'del': out += '<del>' + renderInline(ctx, tok.tokens) + '</del>'; break;
      case 'text': {
        const rendered = renderTextToken(tok);
        out += rendered === null ? renderInline(ctx, tok.tokens) : rendered;
        break;
      }
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.\nPlease report this to https://github.com/markedjs/marked.');
    }
  }
  return out;
}

function renderInlinePlain(ctx, tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += tok.text; break;
      case 'html': out += tok.text; break;
      case 'link':
      case 'image':
        out += tok.tokens ? renderInlinePlain(ctx, tok.tokens) : tok.text;
        break;
      case 'checkbox': out += tok.raw; break;
      case 'strong':
      case 'em':
      case 'del':
        out += tok.tokens ? renderInlinePlain(ctx, tok.tokens) : tok.text;
        break;
      case 'codespan': out += tok.text; break;
      case 'br': break;
      case 'text': out += tok.text; break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.\nPlease report this to https://github.com/markedjs/marked.');
    }
  }
  return out;
}

function renderTokens(ctx, tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading':
        out += '<h' + tok.depth + '>' + renderInline(ctx, tok.tokens) + '</h' + tok.depth + '>\n';
        break;
      case 'code': out += renderCodeBlock(tok); break;
      case 'table': out += renderTable(ctx, tok); break;
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(ctx, tok.tokens) + '</blockquote>\n';
        break;
      case 'list': out += renderList(ctx, tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph':
        out += '<p>' + renderInline(ctx, tok.tokens) + '</p>\n';
        break;
      case 'text': {
        const rendered = renderTextToken(tok);
        out += rendered === null ? renderInline(ctx, tok.tokens) : rendered;
        break;
      }
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.\nPlease report this to https://github.com/markedjs/marked.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render a Markdown document to HTML, byte-for-byte the output of
 * marked 18.1.3 with default options.
 */
export function parse(markdown) {
  const ctx = {
    links: Object.create(null),
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    queue: [],
    maskStack: [],
  };
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const tokens = [];
  blockTokens(ctx, src, tokens, false);
  for (let i = 0; i < ctx.queue.length; i++) {
    const entry = ctx.queue[i];
    ctx.state.inRawBlock = false;
    inlineTokens(ctx, entry.src, entry.tokens);
  }
  ctx.queue = [];
  return renderTokens(ctx, tokens);
}
