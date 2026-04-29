/**
 * Revert orchestrator. Re-applies the primary and associated
 * manifests captured in a snapshot, restoring the pre-mutation
 * state.
 *
 * Single-resource scope for Week 1 — the "associated" set is
 * captured but not mutated on revert unless one of the associated
 * resources was the *actual* mutation target (e.g., a ConfigMap
 * update).
 *
 * Multi-resource atomicity (Helm releases, operator-reconciled
 * resources) needs a broader revert story. See Phase-1-Week-3 edge
 * cases and Phase-2 refinements.
 */

import type { ClusterClient } from './cluster-client.js';
import type { Snapshot } from './types.js';

export async function revert(
  client: ClusterClient,
  snap: Snapshot,
): Promise<void> {
  // Apply primary first. If the mutation was to an associated
  // resource (e.g., ConfigMap that the primary references), the
  // associated re-apply below handles it.
  await client.apply(snap.primary, snap.primaryManifest);

  // Re-apply any associated resources so the full pre-mutation
  // state is restored. Typically a no-op — associated resources
  // aren't usually mutated — but we pay the round-trip for
  // correctness since this is the "safety net" path.
  for (const a of snap.associated) {
    await client.apply(a.ref, a.manifest);
  }
}
