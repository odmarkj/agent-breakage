/**
 * Shared types for the speculative-execution controller.
 *
 * The controller wraps Emily's tier-2 mutating tools:
 *   1. snapshot the mutation target + associated resources BEFORE
 *      the tool runs
 *   2. let the tool run
 *   3. watch cluster SLOs for a configurable window after
 *   4. if a regression fires within the window, revert via the snapshot
 *   5. deliver a mechanical reason back to Emily's agent loop;
 *      semantic analysis is her job on the next cycle
 *
 * Phase-1 Week-1 scope: single-resource kubectl mutations
 * (deployment patch, configmap update, secret create). Multi-resource
 * (Helm releases, operator-reconciled resources) is deferred.
 */

export type ResourceKind =
  | 'Deployment'
  | 'StatefulSet'
  | 'ConfigMap'
  | 'Secret'
  | 'Service'
  | 'HorizontalPodAutoscaler'
  | 'PodDisruptionBudget';

export interface ResourceRef {
  kind: ResourceKind;
  namespace: string;
  name: string;
}

export interface Snapshot {
  /** Primary resource being mutated. */
  primary: ResourceRef;
  /** Full manifest captured pre-mutation (raw JSON per Kubernetes API). */
  primaryManifest: Record<string, unknown>;
  /** Associated resources captured at the same time (ConfigMaps, Secrets, PDBs, HPAs). */
  associated: Array<{ ref: ResourceRef; manifest: Record<string, unknown> }>;
  /** When the snapshot was taken. */
  takenAt: string; // ISO-8601
  /** Stable ID returned by snapshot(); callers pass this back to revert(). */
  id: string;
  /** Which scenario this snapshot was taken under. Null for production use. */
  scenario_id: string | null;
}

export interface SloMetricDelta {
  metric: string;        // e.g. "error_rate{ns=prod-advocate}"
  before: number;        // observed value pre-mutation
  after: number;         // observed value post-mutation
  delta: number;         // after - before
  threshold: number;     // beyond which this is considered a regression
  exceededAt: string;    // ISO-8601; when it crossed
}

export interface RegressionEvent {
  /** Which metric tripped. */
  delta: SloMetricDelta;
  /**
   * Human-readable mechanical reason string. E.g.
   * "error_rate{ns=prod-advocate} rose from 0.3% to 8.1% within 34s
   *  of your patch, exceeding the 2% regression threshold".
   *
   * Semantic analysis — *why* the metric rose — is NOT the
   * controller's job. Emily produces that in her next postmortem.
   */
  mechanicalReason: string;
}

export type RevertOutcome =
  | {
      type: 'reverted';
      revertedAt: string;
      attempt: number;  // 1-indexed
      event: RegressionEvent;
    }
  | {
      type: 'held';  // no regression observed during SLO-watch window
      attempt: number;
    }
  | {
      type: 'paused-for-approval';
      attempt: number;  // will be ≥ MAX_ATTEMPTS
      reason: string;
    };

/** Max auto-revert cycles on the same scenario before pause-and-escalate. */
export const MAX_REVERT_ATTEMPTS = 2;
