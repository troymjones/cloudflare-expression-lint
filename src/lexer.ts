/**
 * Lexer (tokenizer) for Cloudflare expressions.
 *
 * Converts a raw expression string into a sequence of tokens.
 */

import { Token, TokenType } from './types.js';
import { ALL_COMPARISON_NAMES, ALL_LOGICAL_NAMES } from './schemas/operators.js';
import { FUNCTIONS } from './schemas/functions.js';

const FUNCTION_NAMES = new Set(FUNCTIONS.map(f => f.name));

// Keywords that are comparison operators (english form)
const COMPARISON_KEYWORDS = new Set([
  'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'contains', 'matches', 'in', 'wildcard',
]);

// Keywords that are logical operators (english form)
const LOGICAL_KEYWORDS = new Set(['and', 'or', 'not', 'xor']);

// Known field prefixes for disambiguation
const FIELD_PREFIXES = [
  'http.', 'ip.', 'cf.', 'ssl', 'raw.', 'tcp.', 'udp.',
];

/**
 * Tokenize a Cloudflare expression string.
 * @throws Error on unterminated strings or unrecognized characters
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  function col(): number {
    return pos - lineStart + 1;
  }

  function peek(): string {
    return pos < input.length ? input[pos] : '\0';
  }

  function peekAt(offset: number): string {
    const idx = pos + offset;
    return idx < input.length ? input[idx] : '\0';
  }

  function advance(): string {
    const ch = input[pos++];
    if (ch === '\n') {
      line++;
      lineStart = pos;
    }
    return ch;
  }

  function skipWhitespace(): void {
    while (pos < input.length && /\s/.test(input[pos])) {
      advance();
    }
  }

  function readString(): string {
    const startPos = pos;
    advance(); // consume opening quote
    let value = '';
    while (pos < input.length && input[pos] !== '"') {
      if (input[pos] === '\\') {
        advance(); // consume backslash
        const escaped = advance();
        switch (escaped) {
          case '"': value += '"'; break;
          case '\\': value += '\\'; break;
          case 'n': value += '\n'; break;
          case 't': value += '\t'; break;
          default: value += escaped; break;
        }
      } else {
        value += advance();
      }
    }
    if (pos >= input.length) {
      throw new Error(`Unterminated string starting at position ${startPos}`);
    }
    advance(); // consume closing quote
    return value;
  }

  function readIdentifier(): string {
    let ident = '';
    while (pos < input.length && /[a-zA-Z0-9_.]/.test(input[pos])) {
      ident += advance();
    }
    // Remove trailing dot if any (shouldn't normally happen)
    if (ident.endsWith('.')) {
      pos--;
      ident = ident.slice(0, -1);
    }
    return ident;
  }

  function readNumber(): string {
    let num = '';
    while (pos < input.length && /[0-9]/.test(input[pos])) {
      num += advance();
    }
    return num;
  }

  function isIPChar(ch: string): boolean {
    return /[0-9.:]/.test(ch);
  }

  /** Check if the upcoming characters look like an IP address or CIDR */
  function looksLikeIP(): boolean {
    // Save position
    let tempPos = pos;
    let dotCount = 0;
    let hasDigit = false;

    while (tempPos < input.length && /[0-9.]/.test(input[tempPos])) {
      if (input[tempPos] === '.') dotCount++;
      else hasDigit = true;
      tempPos++;
    }

    // IP addresses have exactly 3 dots (a.b.c.d)
    return dotCount === 3 && hasDigit;
  }

  function addToken(type: TokenType, value: string, startPos: number, startLine: number, startCol: number): void {
    tokens.push({ type, value, position: startPos, line: startLine, column: startCol });
  }

  while (pos < input.length) {
    skipWhitespace();
    if (pos >= input.length) break;

    const startPos = pos;
    const startLine = line;
    const startCol = col();
    const ch = peek();

    // ── Raw String Literal (r"...", r#"..."#, r##"..."##, etc.) ─────
    if (ch === 'r' && (peekAt(1) === '"' || peekAt(1) === '#')) {
      advance(); // consume 'r'
      let hashCount = 0;
      while (peek() === '#') {
        advance();
        hashCount++;
      }
      if (peek() !== '"') {
        throw new Error(`Expected '"' after r${'#'.repeat(hashCount)} at position ${pos}`);
      }
      advance(); // consume opening "
      let value = '';
      const closingDelim = '"' + '#'.repeat(hashCount);
      while (pos < input.length) {
        if (input[pos] === '"') {
          // Check if followed by the right number of #'s
          let matched = true;
          for (let h = 0; h < hashCount; h++) {
            if (input[pos + 1 + h] !== '#') {
              matched = false;
              break;
            }
          }
          if (matched) {
            advance(); // consume closing "
            for (let h = 0; h < hashCount; h++) advance(); // consume #'s
            break;
          }
        }
        value += advance();
      }
      addToken(TokenType.RawString, value, startPos, startLine, startCol);
      continue;
    }

    // ── String Literal ───────────────────────────────────────────────
    if (ch === '"') {
      const value = readString();
      addToken(TokenType.String, value, startPos, startLine, startCol);
      continue;
    }

    // ── Parentheses ──────────────────────────────────────────────────
    if (ch === '(') {
      advance();
      addToken(TokenType.LeftParen, '(', startPos, startLine, startCol);
      continue;
    }
    if (ch === ')') {
      advance();
      addToken(TokenType.RightParen, ')', startPos, startLine, startCol);
      continue;
    }

    // ── Curly Braces ─────────────────────────────────────────────────
    if (ch === '{') {
      advance();
      addToken(TokenType.LeftBrace, '{', startPos, startLine, startCol);
      continue;
    }
    if (ch === '}') {
      advance();
      addToken(TokenType.RightBrace, '}', startPos, startLine, startCol);
      continue;
    }

    // ── Square Brackets ──────────────────────────────────────────────
    if (ch === '[') {
      // Check for [*] array unpack
      if (peekAt(1) === '*' && peekAt(2) === ']') {
        advance(); advance(); advance();
        addToken(TokenType.ArrayUnpack, '[*]', startPos, startLine, startCol);
        continue;
      }
      advance();
      addToken(TokenType.LeftBracket, '[', startPos, startLine, startCol);
      continue;
    }
    if (ch === ']') {
      advance();
      addToken(TokenType.RightBracket, ']', startPos, startLine, startCol);
      continue;
    }

    // ── Comma ────────────────────────────────────────────────────────
    if (ch === ',') {
      advance();
      addToken(TokenType.Comma, ',', startPos, startLine, startCol);
      continue;
    }

    // ── Range (..) ───────────────────────────────────────────────────
    if (ch === '.' && peekAt(1) === '.') {
      advance(); advance();
      addToken(TokenType.DotDot, '..', startPos, startLine, startCol);
      continue;
    }

    // ── Slash (for CIDR) ─────────────────────────────────────────────
    if (ch === '/') {
      advance();
      addToken(TokenType.Slash, '/', startPos, startLine, startCol);
      continue;
    }

    // ── Named List ($...) ────────────────────────────────────────────
    if (ch === '$') {
      advance(); // consume $
      const name = readIdentifier();
      addToken(TokenType.NamedList, '$' + name, startPos, startLine, startCol);
      continue;
    }

    // ── Symbol Operators ─────────────────────────────────────────────
    if (ch === '=' && peekAt(1) === '=') {
      advance(); advance();
      addToken(TokenType.ComparisonOp, '==', startPos, startLine, startCol);
      continue;
    }
    if (ch === '!' && peekAt(1) === '=') {
      advance(); advance();
      addToken(TokenType.ComparisonOp, '!=', startPos, startLine, startCol);
      continue;
    }
    if (ch === '<' && peekAt(1) === '=') {
      advance(); advance();
      addToken(TokenType.ComparisonOp, '<=', startPos, startLine, startCol);
      continue;
    }
    if (ch === '>' && peekAt(1) === '=') {
      advance(); advance();
      addToken(TokenType.ComparisonOp, '>=', startPos, startLine, startCol);
      continue;
    }
    if (ch === '<') {
      advance();
      addToken(TokenType.ComparisonOp, '<', startPos, startLine, startCol);
      continue;
    }
    if (ch === '>') {
      advance();
      addToken(TokenType.ComparisonOp, '>', startPos, startLine, startCol);
      continue;
    }
    if (ch === '~') {
      advance();
      addToken(TokenType.ComparisonOp, '~', startPos, startLine, startCol);
      continue;
    }
    if (ch === '&' && peekAt(1) === '&') {
      advance(); advance();
      addToken(TokenType.LogicalOp, '&&', startPos, startLine, startCol);
      continue;
    }
    if (ch === '|' && peekAt(1) === '|') {
      advance(); advance();
      addToken(TokenType.LogicalOp, '||', startPos, startLine, startCol);
      continue;
    }
    if (ch === '^' && peekAt(1) === '^') {
      advance(); advance();
      addToken(TokenType.LogicalOp, '^^', startPos, startLine, startCol);
      continue;
    }
    if (ch === '!') {
      advance();
      addToken(TokenType.LogicalOp, '!', startPos, startLine, startCol);
      continue;
    }

    // ── Numbers / IP Addresses ───────────────────────────────────────
    if (/[0-9]/.test(ch)) {
      // Check if this looks like an IP address (inside { } list context)
      // We determine context by checking if we're inside braces
      let lastOpenBrace = -1;
      let lastCloseBrace = -1;
      for (let idx = tokens.length - 1; idx >= 0; idx--) {
        if (lastOpenBrace === -1 && tokens[idx].type === TokenType.LeftBrace) lastOpenBrace = idx;
        if (lastCloseBrace === -1 && tokens[idx].type === TokenType.RightBrace) lastCloseBrace = idx;
      }
      const inBraces = lastOpenBrace >= 0 && lastOpenBrace > lastCloseBrace;

      if (inBraces && looksLikeIP()) {
        // Read full IP address
        let ip = '';
        while (pos < input.length && /[0-9.:]/.test(input[pos])) {
          ip += advance();
        }
        addToken(TokenType.IPAddress, ip, startPos, startLine, startCol);
        continue;
      }

      const num = readNumber();
      // Check if followed by dots (could be IP outside braces, or just an integer)
      if (peek() === '.' && /[0-9]/.test(peekAt(1)) && peekAt(1) !== '.') {
        // Could be IP address - peek ahead
        const savedPos = pos;
        let maybeIP = num;
        let dotCount = 0;
        let tempPos = pos;
        while (tempPos < input.length && /[0-9.]/.test(input[tempPos])) {
          if (input[tempPos] === '.') dotCount++;
          tempPos++;
        }
        if (dotCount === 3) {
          // Looks like an IP
          while (pos < input.length && /[0-9.]/.test(input[pos])) {
            maybeIP += advance();
          }
          addToken(TokenType.IPAddress, maybeIP, startPos, startLine, startCol);
          continue;
        }
      }
      addToken(TokenType.Integer, num, startPos, startLine, startCol);
      continue;
    }

    // ── Identifiers / Keywords / Fields / Functions ──────────────────
    if (/[a-zA-Z_]/.test(ch)) {
      const ident = readIdentifier();

      // Check for "strict wildcard" (two-word operator)
      if (ident === 'strict') {
        const savedPos = pos;
        const savedLine = line;
        const savedLineStart = lineStart;
        skipWhitespace();
        if (pos < input.length) {
          const nextStart = pos;
          const peek = readIdentifier();
          if (peek === 'wildcard') {
            addToken(TokenType.ComparisonOp, 'strict wildcard', startPos, startLine, startCol);
            continue;
          }
          // Not "strict wildcard" — backtrack
          pos = savedPos;
          line = savedLine;
          lineStart = savedLineStart;
        }
      }

      // Boolean literals
      if (ident === 'true' || ident === 'false') {
        addToken(TokenType.Boolean, ident, startPos, startLine, startCol);
        continue;
      }

      // Comparison operator keywords
      if (COMPARISON_KEYWORDS.has(ident)) {
        addToken(TokenType.ComparisonOp, ident, startPos, startLine, startCol);
        continue;
      }

      // Logical operator keywords
      if (LOGICAL_KEYWORDS.has(ident)) {
        addToken(TokenType.LogicalOp, ident, startPos, startLine, startCol);
        continue;
      }

      // Check if this is a function call (followed by '(')
      skipWhitespace();
      if (peek() === '(' && (FUNCTION_NAMES.has(ident) || isLikelyFunction(ident))) {
        addToken(TokenType.Function, ident, startPos, startLine, startCol);
        continue;
      }

      // Otherwise it's a field
      addToken(TokenType.Field, ident, startPos, startLine, startCol);
      continue;
    }

    // ── Unknown Character ────────────────────────────────────────────
    throw new Error(`Unexpected character '${ch}' at position ${pos} (line ${line}, col ${col()})`);
  }

  addToken(TokenType.EOF, '', pos, line, col());
  return tokens;
}

/**
 * Heuristic: treat identifier-followed-by-paren as a function even if not
 * in the known registry (we'll catch unknown functions in the validator).
 */
function isLikelyFunction(name: string): boolean {
  // All Cloudflare functions use snake_case and are lowercase
  return /^[a-z][a-z0-9_]*$/.test(name) && !name.includes('.');
}
