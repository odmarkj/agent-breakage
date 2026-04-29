import type { CostTier, LLMProvider } from '../types.js';
import { AnthropicProvider } from './anthropic.js';

/**
 * Provider factory. Returns an LLMProvider for the requested cost tier.
 *
 * For now, all tiers use Anthropic (Haiku/Sonnet/Opus).
 * OpenAI and Google providers can be added by implementing the LLMProvider interface
 * and wiring them in here.
 */
export function getProvider(tier: CostTier): LLMProvider {
  // TODO: support openai/google providers via env config
  return new AnthropicProvider(tier);
}

/** Pick the cheapest provider that can handle a given triage decision. */
export function tierForDecision(decision: string): CostTier {
  switch (decision) {
    case 'ignore':
    case 'log':
      return 'low';
    case 'routine':
      return 'medium';
    case 'urgent':
    case 'escalate':
      return 'high';
    default:
      return 'medium';
  }
}
