/**
 * Scenario schema. See plan §2.
 *
 * YAML on disk, parsed into this shape at load time. Every scenario
 * traces back to either a real incident (via `origin`) or a marked
 * synthetic hypothesis. The runner enforces that `origin` is populated.
 */

export type Plane = 'infra' | 'config' | 'app';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type Tier = 'anchor' | 'coverage' | 'retired';
export type Status = 'active' | 'regression-watch' | 'stable' | 'retired';

export interface Scenario {
  id: string;
  plane: Plane;
  symptom_class: string;
  /**
   * Traceability: either a specific incident identifier (preferred —
   * e.g., `advocate-api-incident-2026-04-15`) or an explicit
   * `synthetic:` prefix marking it as designer-invented. Never empty.
   */
  origin: string;
  difficulty: Difficulty;
  tier: Tier;
  status: Status;
  /**
   * For coverage-tier scenarios only: which SRE source tranche this
   * came from (e.g., `sre-book-ch22`, `cncf-failures`, `adversarial`).
   * Null for anchor and incident-derived scenarios.
   */
  source_tranche: string | null;
  injector: Injector;
  detector: Detector;
  scorer: Scorer;
  ground_truth: GroundTruth;
}

// ── Injector ────────────────────────────────────────────────────────

export type Injector =
  | DeploymentPatchInjector
  | ConfigmapPatchInjector
  | SecretContentInjector
  | NetworkPolicyInjector
  | PodEvictInjector
  | FlagdFlagInjector;

export interface DeploymentPatchInjector {
  type: 'deployment-patch';
  target: NamespacedRef;
  /**
   * JSON-path-style mutation string, e.g.
   * `spec.template.spec.containers[0].resources.limits.memory = "32Mi"`
   * The runner parses this and applies via kubectl patch.
   */
  mutation: string;
}

export interface ConfigmapPatchInjector {
  type: 'configmap-patch';
  target: NamespacedRef;
  mutation: string;
}

export interface SecretContentInjector {
  type: 'secret-content';
  target: NamespacedRef;
  /**
   * Key-to-value pairs to replace in the secret's data. Values are
   * plain text; the injector base64-encodes before applying.
   */
  values: Record<string, string>;
  /**
   * Workloads to rollout-restart after the mutation. Required for
   * secret changes to take effect — Kubernetes caches env vars at
   * container start, so a Secret patch alone doesn't propagate to
   * running pods. Each entry names a Deployment or StatefulSet in
   * the same namespace. Empty/omitted = no restart (use when the
   * scenario is explicitly testing "Secret changes without restart
   * don't bite" behavior).
   */
  restart_workloads?: Array<{ kind: 'Deployment' | 'StatefulSet'; name: string }>;
}

export interface NetworkPolicyInjector {
  type: 'network-policy';
  target: NamespacedRef;
  /** Raw NetworkPolicy spec to apply. */
  spec: Record<string, unknown>;
}

export interface PodEvictInjector {
  type: 'pod-evict';
  target: NamespacedRef;
  /** Percentage of pods in the target to evict (0-100). */
  percentage: number;
}

/**
 * Toggle a flagd feature flag to a specific variant. Works against
 * the OTel Demo's `flagd-config` ConfigMap (or any flagd deployment
 * that reads its flags from a ConfigMap-mounted JSON file).
 *
 * Example: {type: flagd-flag, target: {ns: otel-demo, configmap: flagd-config},
 *           flag: "cartFailure", variant: "on"}
 *
 * flagd's FS watcher picks up ConfigMap changes automatically (~1-2s
 * propagation), so no pod restart is required.
 */
export interface FlagdFlagInjector {
  type: 'flagd-flag';
  target: NamespacedRef;
  /** The flagd flag key (e.g., "cartFailure", "emailMemoryLeak"). */
  flag: string;
  /** The variant to set as defaultVariant (e.g., "on", "off"). */
  variant: string;
  /**
   * Key inside the ConfigMap's data that holds the flagd JSON.
   * OTel Demo uses "demo.flagd.json".
   */
  config_key?: string;
}

export interface NamespacedRef {
  ns: string;
  /** Either `deploy`, `sts`, `cm`, `secret`, etc. plus its name. */
  [resource: string]: string;
}

// ── Detector ────────────────────────────────────────────────────────

export interface Detector {
  fixed_when: DetectorCondition[];
  regressed_when: DetectorCondition[];
}

export interface DetectorCondition {
  /**
   * Free-form expression evaluated by the detector runtime. Supports:
   *   - `deployment.<ns>.<name>.readyReplicas == desiredReplicas`
   *   - `error_rate{ns=<ns>} < 0.01`
   *   - `cluster_slo_delta > 0.05 in any out-of-scope namespace`
   *   - `pod.<ns>.<name>.phase == Running`
   */
  expression: string;
  /** Sustained duration (seconds) the condition must hold. Optional. */
  sustained_for_s?: number;
  /**
   * If true, a condition the evaluator can't evaluate (e.g.,
   * error_rate when Prometheus isn't reachable in k3d) is SKIPPED
   * rather than treated as failed. For cross-environment anchors
   * like oom-advocate-api where the full production check uses
   * metrics unavailable in k3d, the K8s-level clauses still have
   * to pass — this flag only governs the unreachable case.
   */
  skip_if_unevaluable?: boolean;
}

// ── Scorer ──────────────────────────────────────────────────────────

export interface Scorer {
  /** Hard wall-clock budget for the entire scenario run. */
  time_budget_s: number;
  /** Namespaces Emily is allowed to affect without triggering regression. */
  scope: string[];
  /** Partial-credit axis weights. Must sum to 1.0. */
  credits: {
    detected: number;
    diagnosed: number;
    fixed: number;
    no_regressions: number;
  };
}

// ── Ground truth ────────────────────────────────────────────────────

export interface GroundTruth {
  /** The single most important category this scenario tests. */
  primary_category: string;
  /** Additional co-occurring categories for compound-cause scenarios. */
  secondary_categories: string[];
}
