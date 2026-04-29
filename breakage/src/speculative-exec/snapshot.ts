/**
 * State snapshot service.
 *
 * Before any tier-2 mutation, call snapshot() to capture the primary
 * resource plus its associated resources. The returned Snapshot
 * carries enough state to reconstruct the pre-mutation world via
 * ClusterClient.apply().
 */

import { randomUUID } from 'node:crypto';
import type { ClusterClient } from './cluster-client.js';
import type { ResourceRef, Snapshot } from './types.js';

export async function snapshot(
  client: ClusterClient,
  primary: ResourceRef,
  options: { scenario_id?: string | null } = {},
): Promise<Snapshot> {
  const primaryManifest = await client.get(primary);
  const associatedRefs = await client.findAssociated(primary);

  // Capture associated resources in parallel. Any individual failure
  // aborts the snapshot — a partial snapshot is worse than none,
  // because revert would leave the cluster in an unknown state.
  const associated = await Promise.all(
    associatedRefs.map(async (ref) => ({
      ref,
      manifest: await client.get(ref),
    })),
  );

  return {
    id: randomUUID(),
    primary,
    primaryManifest,
    associated,
    takenAt: new Date().toISOString(),
    scenario_id: options.scenario_id ?? null,
  };
}
