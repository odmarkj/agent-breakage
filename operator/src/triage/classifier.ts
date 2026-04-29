import type { ClusterEvent, TriageDecision } from '../types.js';
import { getProvider } from '../provider/index.js';

/**
 * Uses a cheap LLM (Haiku) to classify events that pass the heuristic filter.
 * Returns one of: ignore, log, routine, urgent, escalate.
 */
export async function classifyEvent(event: ClusterEvent): Promise<TriageDecision> {
  const provider = getProvider('low');

  const prompt = `You are a Kubernetes cluster triage system. Classify this event into exactly one category.

Event:
- Source: ${event.source}
- Kind: ${event.kind}
- Summary: ${event.summary}
- Details: ${JSON.stringify(event.details).slice(0, 500)}
- Time: ${event.timestamp.toISOString()}

Categories:
- ignore: not actionable, no response needed
- log: record for context but no immediate action
- routine: handle with standard procedures (restart, scale, investigate)
- urgent: requires immediate attention and action
- escalate: notify human immediately, potential incident

Respond with exactly one word: ignore, log, routine, urgent, or escalate.`;

  try {
    const result = await provider.classify(prompt);
    const decision = result.trim().toLowerCase();

    if (['ignore', 'log', 'routine', 'urgent', 'escalate'].includes(decision)) {
      return decision as TriageDecision;
    }
    return 'log'; // default if classifier returns unexpected value
  } catch {
    return 'log'; // fail safe: log but don't act
  }
}
