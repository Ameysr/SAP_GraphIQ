import type { O2CGraphState } from '../state.js';
import type { ComplexityLevel, TierNumber } from '../../types/index.js';

export async function complexityClassifier(
  state: O2CGraphState
): Promise<Partial<O2CGraphState>> {
  const intent = state.intentType;
  const msg = state.resolvedMessage.toLowerCase();

  let complexity: ComplexityLevel;
  let tierToUse: TierNumber;

  switch (intent) {
    case 'LOOKUP':
      complexity = 'SIMPLE';
      tierToUse = 1;
      break;

    case 'TRAVERSE': {
      // Multi-hop heuristic
      const isComplex = ['full', 'complete', 'entire', 'end to end', 'all steps', 'chain', 'lifecycle']
        .some((kw) => msg.includes(kw));
      complexity = isComplex ? 'COMPLEX' : 'MEDIUM';
      tierToUse = isComplex ? 3 : 2;
      break;
    }

    case 'AGGREGATE':
      complexity = 'MEDIUM';
      tierToUse = 2;
      break;

    case 'DETECT':
    case 'COMPARE':
    case 'UNKNOWN':
    default:
      complexity = 'COMPLEX';
      tierToUse = 3;
      break;
  }

  return { complexity, tierToUse };
}
