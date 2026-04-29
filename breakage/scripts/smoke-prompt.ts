/**
 * Print the system prompt that runAgent would assemble for a
 * given user message. Lets us verify the retrieval + playbook
 * sections are rendered as expected, without paying for an LLM
 * round-trip.
 */

import { isBreakageEnabled, retrievePast, matchPlaybook, renderPlaybook } from '../../operator/src/breakage/index.js';

async function main(): Promise<void> {
  if (!isBreakageEnabled()) {
    console.error('BREAKAGE_RUNNER_URL not set');
    process.exit(1);
  }
  const message = process.argv[2] ?? 'advocate-api pods in prod-advocate are CrashLoopBackOff with SESSION_SECRET missing in logs';
  console.log(`QUERY: ${message}\n`);

  const hits = await retrievePast({ text: message, k: 3, sources: ['incident-log', 'production'] });
  console.log(`Retrieval hits (k=${hits.length}):`);
  for (const h of hits) {
    console.log(`  ${h.outcome.padEnd(10)} distance=${h.distance.toFixed(3)} category=${h.primary_category} id=${h.id}`);
  }
  console.log('');

  const match = await matchPlaybook(
    hits.map((h) => ({ id: h.id, primary_category: h.primary_category, distance: h.distance })),
  );
  if (match) {
    console.log(`Playbook matched: ${match.playbook.id} (via ${match.matched_on})`);
    console.log(`Rendered section:\n`);
    console.log(renderPlaybook(match));
  } else {
    console.log('No playbook matched any retrieved hit\'s category.');
  }
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
