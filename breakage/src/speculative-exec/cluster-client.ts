/**
 * Interface the speculative-exec controller uses to talk to
 * Kubernetes. Abstracting behind this interface lets us unit-test
 * the controller logic (snapshot, watch, revert orchestration)
 * without a real cluster, and swap in the @kubernetes/client-node
 * implementation during runtime.
 */

import type { ResourceRef } from './types.js';

export interface ClusterClient {
  /**
   * Fetch the current manifest of a resource. Returns the full
   * spec as the API server sees it, normalized to remove
   * server-side-managed fields (resourceVersion, managedFields,
   * status) so round-trip apply works cleanly.
   */
  get(ref: ResourceRef): Promise<Record<string, unknown>>;

  /**
   * Replace a resource with the given manifest. Implementations
   * should use server-side apply with force=true where available
   * to avoid resource-version conflicts.
   */
  apply(ref: ResourceRef, manifest: Record<string, unknown>): Promise<void>;

  /**
   * List resources that are associated with the given primary
   * resource — typically ConfigMaps and Secrets referenced by the
   * primary's pod spec, plus PDBs and HPAs that select it.
   */
  findAssociated(primary: ResourceRef): Promise<ResourceRef[]>;
}
