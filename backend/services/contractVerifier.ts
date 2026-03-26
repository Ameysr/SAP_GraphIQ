import type { ContractSpec, ContractCheck, ContractFormulaCheck } from './questionPlans.js';

function coerceNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = Number.parseFloat(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstRow(queryResults: Array<Record<string, unknown>>): Record<string, unknown> {
  return (queryResults && queryResults.length > 0 ? queryResults[0] : {}) as Record<string, unknown>;
}

export function verifyContract(
  queryResults: Array<Record<string, unknown>>,
  contract: ContractSpec
): { valid: boolean; reason?: string } {
  if (!contract) return { valid: true };

  if (!queryResults || queryResults.length === 0) {
    return { valid: false, reason: 'No query results to verify.' };
  }

  const row0 = firstRow(queryResults);

  // Required fields presence check.
  if (contract.requiredFields && contract.requiredFields.length > 0) {
    for (const f of contract.requiredFields) {
      if (!(f in row0)) {
        return { valid: false, reason: `Missing required field: ${f}` };
      }
      const v = row0[f];
      if (v === null || v === undefined) {
        return { valid: false, reason: `Required field is null/undefined: ${f}` };
      }
    }
  }

  const checks = contract.checks ?? [];
  for (const check of checks) {
    const res = verifyCheck(queryResults, row0, check);
    if (!res.valid) return res;
  }

  const formulaChecks = contract.formulaChecks ?? [];
  for (const fc of formulaChecks) {
    const res = verifyFormulaCheck(row0, fc);
    if (!res.valid) return res;
  }

  return { valid: true };
}

function verifyCheck(
  queryResults: Array<Record<string, unknown>>,
  row0: Record<string, unknown>,
  check: ContractCheck
): { valid: boolean; reason?: string } {
  switch (check.type) {
    case 'range': {
      const v = coerceNumber(row0[check.field]);
      if (v === null) return { valid: false, reason: `Field ${check.field} is not numeric` };
      if (v < check.min || v > check.max) {
        return { valid: false, reason: `Field ${check.field} out of range: ${v} not in [${check.min}, ${check.max}]` };
      }
      return { valid: true };
    }
    case 'regex': {
      const v = row0[check.field];
      const s = v === null || v === undefined ? '' : String(v);
      const re = new RegExp(check.pattern);
      if (!re.test(s)) return { valid: false, reason: `Field ${check.field} does not match pattern ${check.pattern}` };
      return { valid: true };
    }
    case 'monotonic': {
      const dir = check.direction;
      const values = queryResults.map((r) => coerceNumber(r[check.field]));
      if (values.some((v) => v === null)) return { valid: false, reason: `Monotonic check field ${check.field} missing/non-numeric` };
      for (let i = 1; i < values.length; i++) {
        const prev = values[i - 1] as number;
        const cur = values[i] as number;
        if (dir === 'desc' && cur > prev) {
          return { valid: false, reason: `Results not monotonic desc for ${check.field}` };
        }
        if (dir === 'asc' && cur < prev) {
          return { valid: false, reason: `Results not monotonic asc for ${check.field}` };
        }
      }
      return { valid: true };
    }
    default:
      return { valid: true };
  }
}

function verifyFormulaCheck(
  row0: Record<string, unknown>,
  fc: ContractFormulaCheck
): { valid: boolean; reason?: string } {
  if (fc.type === 'ratioPercent') {
    const num = coerceNumber(row0[fc.numeratorField]);
    const den = coerceNumber(row0[fc.denominatorField]);
    const target = coerceNumber(row0[fc.targetField]);
    if (num === null || den === null || target === null) {
      return { valid: false, reason: `ratioPercent missing numeric fields` };
    }
    if (den === 0) {
      // If denominator is 0, expect target to be 0 (or very close).
      if (Math.abs(target) > (fc.tolerancePctPoints ?? 0.01)) {
        return { valid: false, reason: `ratioPercent denominator=0 but target=${target}` };
      }
      return { valid: true };
    }
    const computed = (num / den) * 100;
    const tol = fc.tolerancePctPoints ?? 0.5;
    if (Math.abs(computed - target) > tol) {
      return { valid: false, reason: `ratioPercent mismatch: computed=${computed}, target=${target}, tol=${tol}` };
    }
    return { valid: true };
  }

  return { valid: true };
}

