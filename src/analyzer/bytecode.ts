// ── EVM Disassembler + Selector Extraction ───────────────────────────────────
// Based on transferEventParchasing approach: proper opcode-level disassembly
// instead of raw hex string scanning.

// ── Opcode table ─────────────────────────────────────────────────────────────

interface OpcodeInfo { push: number }

const OP: Record<number, OpcodeInfo> = {};
// PUSH1 (0x60) through PUSH32 (0x7F)
for (let i = 1; i <= 32; i++) OP[0x5F + i] = { push: i };
// Everything else: push = 0 (we only care about PUSH size for disassembly)

function pushSize(opcode: number): number {
  return OP[opcode]?.push ?? 0;
}

// ── Instruction ──────────────────────────────────────────────────────────────

export interface Instruction {
  offset:    number;
  opcode:    number;
  pushData?: string;  // hex string for PUSH1-PUSH32 data (with 0x prefix)
}

// ── Disassembler ─────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function disassemble(bytecodeHex: string): Instruction[] {
  const bytes = hexToBytes(bytecodeHex);
  const instructions: Instruction[] = [];
  let i = 0;
  while (i < bytes.length) {
    const opcode = bytes[i];
    const inst: Instruction = { offset: i, opcode };
    const ps = pushSize(opcode);
    if (ps > 0 && i + ps < bytes.length) {
      let hex = '0x';
      for (let j = 1; j <= ps; j++) hex += bytes[i + j].toString(16).padStart(2, '0');
      inst.pushData = hex;
      i += 1 + ps;
    } else {
      i += 1;
    }
    instructions.push(inst);
  }
  return instructions;
}

// ── Selector extraction (dispatcher pattern) ─────────────────────────────────
// Scans the first ~500 instructions for:
//   PUSH4 <sel> ... EQ ... PUSH1/2 <dest> ... JUMPI
// Skips GT/LT (binary search routing, not actual selectors)

export function extractSelectors(bytecode: string): string[] | null {
  if (!bytecode || bytecode.length < 20) return null;

  const instructions = disassemble(bytecode);
  const limit = Math.min(instructions.length, 500);
  const selectors = new Set<string>();

  for (let i = 0; i < limit; i++) {
    const inst = instructions[i];
    // PUSH4 = 0x63
    if (inst.opcode !== 0x63 || !inst.pushData) continue;
    const sel = inst.pushData.toLowerCase();
    if (sel.length !== 10 || selectors.has(sel)) continue; // "0x" + 8 hex

    // Look ahead ≤10 instructions for EQ → PUSH1/2 → JUMPI
    let foundEq = false;
    for (let j = i + 1; j < Math.min(i + 10, limit); j++) {
      const op = instructions[j];
      if (op.opcode === 0x14) { foundEq = true; continue; }           // EQ
      if (foundEq && (op.opcode === 0x60 || op.opcode === 0x61) && op.pushData) {
        if (j + 1 < limit && instructions[j + 1].opcode === 0x57) {   // JUMPI
          selectors.add(sel);
        }
        break;
      }
      // GT(0x11) / LT(0x10) → binary search routing, not a selector
      if (op.opcode === 0x10 || op.opcode === 0x11) break;
    }
  }

  if (!selectors.size) return null;
  return [...selectors].sort();
}

// ── Pattern matching ─────────────────────────────────────────────────────────

function strip0x(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

/** Contract HAS this function selector (appears in dispatcher) */
export function containsSelector(bytecode: string, selector: string): boolean {
  const sels = extractSelectors(bytecode);
  if (!sels) return false;
  return sels.includes('0x' + strip0x(selector).toLowerCase());
}

/** Contract CALLS this external function (PUSH4 + selector, NOT in dispatcher) */
export function containsCall(bytecode: string, selector: string): boolean {
  if (!bytecode) return false;
  const instructions = disassemble(bytecode);
  const dispatcherSels = new Set(extractSelectors(bytecode) ?? []);
  const target = '0x' + strip0x(selector).toLowerCase();

  for (const inst of instructions) {
    if (inst.opcode === 0x63 && inst.pushData?.toLowerCase() === target) {
      // Skip if this is a dispatcher selector (already matched by containsSelector)
      if (dispatcherSels.has(target)) continue;
      return true;
    }
  }
  return false;
}

/** Raw opcode byte anywhere in bytecode */
export function containsOpcode(bytecode: string, opcode: string): boolean {
  if (!bytecode) return false;
  const target = parseInt(strip0x(opcode), 16);
  const instructions = disassemble(bytecode);
  return instructions.some(i => i.opcode === target);
}

export function matchesPattern(bytecode: string, hexPattern: string, patternType: string): boolean {
  if (!bytecode) return false;
  switch (patternType) {
    case 'opcode':   return containsOpcode(bytecode, hexPattern);
    case 'call':     return containsCall(bytecode, hexPattern);
    case 'selector': return containsSelector(bytecode, hexPattern);
    default:         return false;
  }
}
