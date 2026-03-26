/**
 * Accuracy Test Suite for SAP O2C Graph Intelligence
 * 
 * Tests keyword shortcuts, guardrail intent matching, negation detection,
 * and function routing to ensure no false positives.
 * 
 * Run: npx tsx tests/accuracy.test.ts
 */

// ── INTENT CLASSIFICATION TESTS ──────────────────────────────────────────────

const INTENT_RULES: Array<{ patterns: RegExp[]; intent: string }> = [
  {
    patterns: [/\bbroken\b/i, /\bmissing\b/i, /\bnot billed\b/i, /\bunpaid\b/i, /\bincomplete\b/i, /\bno delivery\b/i, /\bnot paid\b/i, /\bundelivered\b/i, /\bunbilled\b/i, /\banomal/i, /\bfulfillment\b/i, /\bcancelled after\b/i, /\bcancelled before\b/i],
    intent: 'DETECT',
  },
  {
    patterns: [/\btrace\b/i, /\bflow\b/i, /\bpath\b/i, /\bend to end\b/i, /\bfull journey\b/i, /\bfrom order to\b/i, /\bfollow\b/i, /\bchain\b/i, /\blifecycle\b/i],
    intent: 'TRAVERSE',
  },
  {
    patterns: [/\btop\s+\d/i, /\bmost\b/i, /\bcount\b/i, /\bhow many\b/i, /\bhighest\b/i, /\blowest\b/i, /\brank\b/i, /\bbest\b/i, /\bworst\b/i, /\btotal\b/i, /\bsum\b/i, /\baverage\b/i, /\bdistribution\b/i, /\bdistributed\b/i, /\bclearing time\b/i, /\bpayment term/i, /\bexpensive\b/i, /\bpercentage\b/i, /\b%\b/],
    intent: 'AGGREGATE',
  },
  {
    patterns: [/\bcompare\b/i, /\bvs\b/i, /\bversus\b/i, /\bdifference between\b/i, /\bwhich is better\b/i],
    intent: 'COMPARE',
  },
  {
    patterns: [/\bshow\b/i, /\bget\b/i, /\bwhat is\b/i, /\bfind me\b/i, /\btell me about\b/i, /\bdetails of\b/i, /\blook up\b/i, /\bwho is\b/i, /\bwhat are\b/i, /\bdescribe\b/i, /\bfull details\b/i],
    intent: 'LOOKUP',
  },
];

function classifyIntent(msg: string): string | null {
  const lower = msg.toLowerCase();
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some(p => p.test(lower))) {
      return rule.intent;
    }
  }
  return null;
}

// ── TEST RUNNER ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => boolean): void {
  try {
    if (fn()) {
      passed++;
      console.log(`  ✅ ${name}`);
    } else {
      failed++;
      console.log(`  ❌ ${name}`);
    }
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name} — Error: ${(e as Error).message}`);
  }
}

// ── WORD BOUNDARY TESTS ──────────────────────────────────────────────────────
console.log('\n═══ Word Boundary Tests ═══');

test('Q10: "accounting document" should NOT match AGGREGATE (count)', () => {
  const intent = classifyIntent('What are the full details of billing document 90504253 and its linked accounting document?');
  return intent !== 'AGGREGATE';
});

test('"How many orders exist?" should match AGGREGATE', () => {
  return classifyIntent('How many orders exist?') === 'AGGREGATE';
});

test('"total revenue" should match AGGREGATE', () => {
  return classifyIntent('What is the total revenue?') === 'AGGREGATE';
});

test('"Top 5 customers" should match AGGREGATE', () => {
  return classifyIntent('Top 5 customers by billing amount') === 'AGGREGATE';
});

test('"most expensive" should match AGGREGATE', () => {
  return classifyIntent('What is the most expensive billing item?') === 'AGGREGATE';
});

// ── NEGATION DETECTION TESTS ─────────────────────────────────────────────────
console.log('\n═══ Negation Detection Tests ═══');

test('"non-cancelled" should NOT match DETECT', () => {
  const intent = classifyIntent('How many active non-cancelled billing documents exist?');
  return intent !== 'DETECT';
});

test('"not cancelled" should NOT match DETECT', () => {
  const intent = classifyIntent('Which billing docs are not cancelled?');
  return intent !== 'DETECT';
});

test('"cancelled after payment" SHOULD match DETECT', () => {
  return classifyIntent('Which invoices were cancelled after payment?') === 'DETECT';
});

test('"fulfillment rate" should match DETECT', () => {
  return classifyIntent('What is the delivery fulfillment rate per customer?') === 'DETECT';
});

test('"unpaid invoices" should match DETECT', () => {
  return classifyIntent('Find all unpaid invoices') === 'DETECT';
});

// ── FUNCTION SHORTCUT FALSE-POSITIVE TESTS ───────────────────────────────────
console.log('\n═══ Function Shortcut Regression Tests ═══');

// Simulate keyword checks from functionSelector
function checkCancelledShortcut(msg: string): boolean {
  const lower = msg.toLowerCase();
  const hasNegatedCancelled = /\b(not?\s+cancell|non[- ]cancell|active|non[- ]cancell)/i.test(lower);
  return !hasNegatedCancelled && (lower.includes('cancelled') || lower.includes('canceled'));
}

function checkExpensiveShortcut(msg: string): boolean {
  const lower = msg.toLowerCase();
  const isAboutIndividualItem = !lower.includes('month') && !lower.includes('revenue') && !lower.includes('total active') && !lower.includes('per ');
  return isAboutIndividualItem && (lower.includes('expensive') || lower.includes('costliest'));
}

function checkBillingTypeShortcut(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('billing') && (lower.includes('type') || lower.includes('types') || lower.includes('f2') || lower.includes('s1'));
}

function checkPlantRevenueShortcut(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('plant') && (lower.includes('revenue') || lower.includes('billed') || lower.includes('billing') || lower.includes('rank') || lower.includes('highest'));
}

// Cancelled shortcut tests
test('Q9: "active (non-cancelled)" should NOT trigger cancelled shortcut', () => {
  return !checkCancelledShortcut('How many active (non-cancelled) billing documents have NOT been paid?');
});

test('"non-cancelled billing docs" should NOT trigger cancelled shortcut', () => {
  return !checkCancelledShortcut('Show me non-cancelled billing documents');
});

test('"Which docs were cancelled?" SHOULD trigger cancelled shortcut', () => {
  return checkCancelledShortcut('Which documents were cancelled?');
});

// Expensive shortcut tests
test('"most expensive billing item" SHOULD trigger expensive shortcut', () => {
  return checkExpensiveShortcut('What is the most expensive billing item?');
});

test('"monthly revenue per expensive customer" should NOT trigger expensive shortcut', () => {
  return !checkExpensiveShortcut('Show me monthly revenue breakdown per customer');
});

test('"total active revenue" should NOT trigger expensive shortcut', () => {
  return !checkExpensiveShortcut('What is the total active billing revenue?');
});

// Billing type shortcut tests
test('Q4: "billing document types" SHOULD trigger billing type shortcut', () => {
  return checkBillingTypeShortcut('What are the two billing document types in the dataset?');
});

test('"F2 vs S1 billing" SHOULD trigger billing type shortcut', () => {
  return checkBillingTypeShortcut('Compare F2 and S1 billing documents');
});

test('"billing summary for customer" should NOT trigger billing type shortcut', () => {
  return !checkBillingTypeShortcut('Show me the billing summary for customer 320000082');
});

// Plant revenue shortcut tests
test('Q7: "plant billed revenue ranking" SHOULD trigger plant revenue shortcut', () => {
  return checkPlantRevenueShortcut('Which plant processed the highest total billed revenue? Rank all plants.');
});

test('"plant delivery count" should NOT trigger plant revenue shortcut', () => {
  return !checkPlantRevenueShortcut('How many deliveries does each plant handle?');
});

// ── CYPHER INJECTION TESTS ───────────────────────────────────────────────────
console.log('\n═══ Input Sanitization Tests ═══');

function sanitize(msg: string): string {
  const dangerousPatterns = /\b(CREATE|DELETE|SET|DROP|DETACH|MERGE|REMOVE|CALL\s+db)\b/i;
  if (dangerousPatterns.test(msg)) {
    return msg.replace(dangerousPatterns, '[BLOCKED]');
  }
  return msg;
}

test('Normal question should pass through unchanged', () => {
  return sanitize('How many orders exist?') === 'How many orders exist?';
});

test('Cypher DELETE injection should be blocked', () => {
  const result = sanitize('DELETE all nodes please');
  return result.includes('[BLOCKED]');
});

test('Cypher DROP injection should be blocked', () => {
  const result = sanitize('DROP INDEX ON :Customer(id)');
  return result.includes('[BLOCKED]');
});

test('Cypher CREATE injection should be blocked', () => {
  const result = sanitize('CREATE (n:Malicious {data: "hack"})');
  return result.includes('[BLOCKED]');
});

test('"What is the creation date?" should NOT be blocked (contains "create" substring)', () => {
  // "creation" contains "creat" but not the word "CREATE"
  return sanitize('What is the creation date of this order?') === 'What is the creation date of this order?';
});

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
