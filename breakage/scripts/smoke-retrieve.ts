/**
 * Smoke test for the operator-side breakage client.
 *
 * Simulates what agent.ts does at the start of a chat request:
 *   1. Check isBreakageEnabled()
 *   2. Call retrievePast(text) with the user's question
 *   3. Render the retrieval section
 *
 * Prints the resulting system-prompt section so we can eyeball the
 * quality of the retrieval hits before wiring Emily up for real.
 */

import { isBreakageEnabled, retrievePast } from '../../operator/src/breakage/index.js';

async function main(): Promise<void> {
  if (!isBreakageEnabled()) {
    console.error('BREAKAGE_RUNNER_URL is not set — retrieval hook would be a no-op.');
    process.exit(1);
  }

  const queries = [
    'advocate-api pods keep OOMKilling, memory pressure, containers restarting',
    'password authentication failed for user publisher_reviews — should I rotate the credential?',
    'advocate-secrets looks empty, base64 data is there but I cannot tell what it contains',
  ];

  for (const q of queries) {
    console.log('────────────────────────────────────────────────────────────────');
    console.log(`QUERY: ${q}`);
    console.log('────────────────────────────────────────────────────────────────');
    const hits = await retrievePast({ text: q, k: 3 });
    if (hits.length === 0) {
      console.log('(no hits)');
    } else {
      for (const h of hits) {
        console.log(
          `  ${h.outcome.padEnd(10)} distance=${h.distance.toFixed(3)} ` +
            `category=${h.primary_category}`,
        );
        console.log(`    ${h.id}`);
        console.log(`    diagnosis: ${h.final_diagnosis.split('\n')[0].slice(0, 100)}…`);
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('[smoke-retrieve] failed:', err);
  process.exit(1);
});
