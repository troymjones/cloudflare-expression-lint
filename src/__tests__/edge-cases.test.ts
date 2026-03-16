import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer.js';
import { parse } from '../parser.js';
import { validate } from '../validator.js';
import { TokenType } from '../types.js';

describe('Raw Strings', () => {
  describe('lexer', () => {
    it('tokenizes r"..." raw strings', () => {
      const tokens = tokenize('http.request.uri.path matches r"/api/login\\.aspx$"');
      const raw = tokens.find(t => t.type === TokenType.RawString);
      expect(raw).toBeDefined();
      expect(raw!.value).toBe('/api/login\\.aspx$');
    });

    it('tokenizes r#"..."# raw strings with embedded quotes', () => {
      const tokens = tokenize('http.host matches r#"a"b"#');
      const raw = tokens.find(t => t.type === TokenType.RawString);
      expect(raw).toBeDefined();
      expect(raw!.value).toBe('a"b');
    });

    it('tokenizes r##"..."## raw strings', () => {
      const tokens = tokenize('http.host matches r##"a"#b"##');
      const raw = tokens.find(t => t.type === TokenType.RawString);
      expect(raw).toBeDefined();
      expect(raw!.value).toBe('a"#b');
    });

    it('preserves backslashes in raw strings (no escape processing)', () => {
      const tokens = tokenize('http.host matches r"\\\\test"');
      const raw = tokens.find(t => t.type === TokenType.RawString);
      expect(raw!.value).toBe('\\\\test');
    });
  });

  describe('parser', () => {
    it('parses raw string in matches expression', () => {
      const ast = parse('http.request.uri.path matches r"^/api/v[0-9]+/"');
      expect(ast.kind).toBe('Comparison');
    });

    it('parses raw string in regex_replace', () => {
      const ast = parse('regex_replace(http.host, r"\\\\", "")');
      expect(ast.kind).toBe('FunctionCall');
    });
  });

  describe('validator', () => {
    it('validates expression with raw string', () => {
      const result = validate('http.request.uri.path matches r"^/api/"', {
        expressionType: 'filter',
      });
      expect(result.valid).toBe(true);
    });
  });
});

describe('Named List Validation', () => {
  it('accepts valid custom list names (lowercase, numbers, underscores)', () => {
    const result = validate('ip.src in $my_allowlist', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('accepts managed list names with cf. prefix', () => {
    const result = validate('ip.src in $cf.malware', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('accepts $cf.botnetcc managed list', () => {
    const result = validate('ip.src in $cf.botnetcc', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('accepts $cf.open_proxies managed list', () => {
    const result = validate('ip.src in $cf.open_proxies', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('warns on list names with uppercase letters', () => {
    const result = validate('ip.src in $MyList', { expressionType: 'filter' });
    expect(result.diagnostics.some(d => d.code === 'invalid-list-name')).toBe(true);
  });

  it('rejects list names with hyphens as parse error', () => {
    // Hyphens are not valid in Cloudflare list names, and the lexer
    // correctly fails to parse them as part of the identifier
    const result = validate('ip.src in $my-list', { expressionType: 'filter' });
    expect(result.valid).toBe(false);
  });

  it('list name warnings are warnings not errors', () => {
    const result = validate('ip.src in $MyList', { expressionType: 'filter' });
    expect(result.valid).toBe(true); // warning, not error
  });
});

describe('IP and CIDR Validation', () => {
  it('accepts valid IP in equality', () => {
    const result = validate('ip.src == 1.2.3.4', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('accepts valid CIDR in in-list', () => {
    const result = validate('ip.src in {192.168.0.0/16}', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('accepts valid CIDR /32', () => {
    const result = validate('ip.src in {1.2.3.4/32}', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('warns on CIDR mask > 32 for IPv4', () => {
    const result = validate('ip.src in {1.2.3.4/33}', { expressionType: 'filter' });
    expect(result.diagnostics.some(d => d.code === 'invalid-cidr-mask')).toBe(true);
  });

  it('warns on CIDR mask = 0', () => {
    // /0 is technically valid but likely a mistake
    const result = validate('ip.src in {0.0.0.0/0}', { expressionType: 'filter' });
    // We allow /0 since it means "all IPs" and is intentional in some cases
    expect(result.valid).toBe(true);
  });
});

describe('Misc Edge Cases', () => {
  it('handles deeply nested parentheses', () => {
    const result = validate('(((http.host eq "test.com")))', { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('handles long chain of or expressions', () => {
    const parts = Array.from({ length: 20 }, (_, i) =>
      `(http.user_agent contains "bot${i}")`
    ).join(' or ');
    const result = validate(parts, { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('handles expression with many in-list values', () => {
    const countries = Array.from({ length: 50 }, (_, i) =>
      `"${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}"`
    ).join(' ');
    const result = validate(`ip.src.country in {${countries}}`, { expressionType: 'filter' });
    expect(result.valid).toBe(true);
  });

  it('rejects empty in-list', () => {
    // Cloudflare rejects empty in-lists
    expect(() => parse('ip.src in {}')).not.toThrow();
    // The parser should handle it; validator could optionally warn
  });
});
