// SPDX-License-Identifier: AGPL-3.0-only
// Lenient JSON (as accepted by SMAPI/Newtonsoft): BOM, // and /* */ comments, trailing commas. Pure.

/** Index just past the string literal that starts at `start` (which must be a '"'). */
function skipString(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '\\') i += 2;
    else if (ch === '"') return i + 1;
    else i += 1;
  }
  return i;
}

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (ch === '"') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (ch === '/' && next === '/') {
      while (i < src.length && src.charAt(i) !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Invalid JSON: unterminated /* comment');
      out += ' ';
      i = end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function stripTrailingCommas(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '"') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src.charAt(j))) j += 1;
      const following = src.charAt(j);
      if (following === '}' || following === ']') {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Lenient JSON parse (strips BOM, // and /* comments, trailing commas). Throws "Invalid JSON: …". */
export function parseLenientJson(text: string): unknown {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const cleaned = stripTrailingCommas(stripComments(withoutBom));
  try {
    return JSON.parse(cleaned) as unknown;
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`, { cause: err });
  }
}
