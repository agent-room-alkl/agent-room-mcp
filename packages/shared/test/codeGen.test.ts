import { describe, it, expect } from 'vitest';
import { generateCode, isValidCode, CODE_CHARS } from '../src/index.js';

describe('generateCode', () => {
  it('returns a string in XXX-XXX-XXX format', () => {
    const code = generateCode();
    expect(code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  });

  it('uses only characters from CODE_CHARS', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateCode().replace(/-/g, '');
      for (const ch of code) {
        expect(CODE_CHARS).toContain(ch);
      }
    }
  });

  it('never contains the excluded characters 0 O I L 1', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateCode();
      expect(code).not.toMatch(/[0OIL1]/);
    }
  });

  it('generates different codes on successive calls (probabilistic)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe('isValidCode', () => {
  it('accepts a well-formed code', () => {
    expect(isValidCode('ABC-DEF-GHJ')).toBe(true);
  });

  it('rejects codes with excluded characters', () => {
    expect(isValidCode('ABC-DEF-GH0')).toBe(false);
    expect(isValidCode('ABC-DEF-GHI')).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidCode('ABC-DEF')).toBe(false);
    expect(isValidCode('ABC-DEF-GHJ-KLM')).toBe(false);
  });

  it('rejects missing dashes', () => {
    expect(isValidCode('ABCDEFGHJ')).toBe(false);
  });

  it('is case sensitive (uppercase only)', () => {
    expect(isValidCode('abc-def-ghj')).toBe(false);
  });
});
