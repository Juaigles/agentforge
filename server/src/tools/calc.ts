// Evaluador de expresiones aritméticas seguro (sin eval): analizador descendente recursivo.
import { ToolError } from '../errors';

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (x, digits = 0) => {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

type Token = { type: 'num'; value: number } | { type: 'id'; value: string } | { type: 'op'; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/%^(),]))/y;
  let pos = 0;
  while (pos < expr.length) {
    if (/^\s*$/.test(expr.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) throw new ToolError(`Carácter no válido en la expresión, posición ${pos + 1}: "${expr.slice(pos, pos + 10)}"`);
    if (m[1] !== undefined) tokens.push({ type: 'num', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: 'id', value: m[2].toLowerCase() });
    else tokens.push({ type: 'op', value: m[3] === '**' ? '^' : m[3] });
    pos = re.lastIndex;
  }
  return tokens;
}

export function evaluateExpression(expr: string): number {
  if (expr.length > 1000) throw new ToolError('La expresión es demasiado larga.');
  // Se aceptan formatos habituales: "×", "÷", coma decimal no (ambigua con separador de argumentos).
  const tokens = tokenize(expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-'));
  let i = 0;

  const peek = (): Token | undefined => tokens[i];
  const isOp = (v: string) => peek()?.type === 'op' && peek()!.value === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ToolError(`Se esperaba "${v}" en la expresión.`);
    i++;
  };

  // expr := term (('+'|'-') term)*
  function parseExpr(): number {
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[i++] as Token).value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  // term := unary (('*'|'/'|'%') unary)*
  function parseTerm(): number {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[i++] as Token).value;
      const right = parseUnary();
      if ((op === '/' || op === '%') && right === 0) throw new ToolError('División entre cero.');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }
  // unary := ('-'|'+') unary | power
  function parseUnary(): number {
    if (isOp('-')) return (i++, -parseUnary());
    if (isOp('+')) return (i++, parseUnary());
    return parsePower();
  }
  // power := primary ('^' unary)?   (asociativa a la derecha)
  function parsePower(): number {
    const base = parsePrimary();
    if (isOp('^')) {
      i++;
      return Math.pow(base, parseUnary());
    }
    return base;
  }
  function parsePrimary(): number {
    const t = tokens[i++];
    if (!t) throw new ToolError('Expresión incompleta.');
    if (t.type === 'num') return t.value;
    if (t.type === 'op' && t.value === '(') {
      const v = parseExpr();
      expect(')');
      return v;
    }
    if (t.type === 'id') {
      if (isOp('(')) {
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new ToolError(`Función desconocida: ${t.value}`);
        i++;
        const args: number[] = [];
        if (!isOp(')')) {
          do {
            args.push(parseExpr());
          } while (isOp(',') && ++i);
        }
        expect(')');
        return fn(...args);
      }
      if (t.value in CONSTANTS) return CONSTANTS[t.value];
      throw new ToolError(`Identificador desconocido: ${t.value}`);
    }
    throw new ToolError(`Símbolo inesperado: ${t.value}`);
  }

  if (!tokens.length) throw new ToolError('La expresión está vacía.');
  const value = parseExpr();
  if (i < tokens.length) throw new ToolError(`Símbolo inesperado: ${String(tokens[i].value)}`);
  if (!Number.isFinite(value)) throw new ToolError('El resultado no es un número finito.');
  return value;
}
