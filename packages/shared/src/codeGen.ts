import { CODE_CHARS, CODE_SEGMENT_LEN, CODE_SEGMENTS } from './constants.js';

function randomChar(): string {
  const idx = Math.floor(Math.random() * CODE_CHARS.length);
  return CODE_CHARS[idx]!;
}

function segment(): string {
  let out = '';
  for (let i = 0; i < CODE_SEGMENT_LEN; i++) out += randomChar();
  return out;
}

export function generateCode(): string {
  const parts: string[] = [];
  for (let i = 0; i < CODE_SEGMENTS; i++) parts.push(segment());
  return parts.join('-');
}

const VALID_RE = new RegExp(
  `^[${CODE_CHARS}]{${CODE_SEGMENT_LEN}}(-[${CODE_CHARS}]{${CODE_SEGMENT_LEN}}){${CODE_SEGMENTS - 1}}$`
);

export function isValidCode(code: string): boolean {
  return VALID_RE.test(code);
}
