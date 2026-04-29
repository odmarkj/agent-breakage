/**
 * flagd-flag injector. Toggles a feature flag in flagd's
 * ConfigMap-backed configuration. Used for scenarios that exercise
 * OpenTelemetry Demo's built-in failure injection surface (15 flags
 * covering cart/payment/product-catalog failures, memory leaks,
 * queue problems, readiness probe misconfigurations, etc.).
 *
 * Approach:
 *   1. fetch the ConfigMap
 *   2. parse the flagd JSON from the named data key
 *   3. flip the flag's `defaultVariant` to the scenario's variant
 *   4. write the ConfigMap back
 *   5. flagd's FS watcher picks up the change within ~1-2s
 *
 * Undo restores the pre-injection JSON verbatim.
 *
 * Important: this injector does NOT use the SpeculativeController
 * wrapper — ConfigMap mutations to the target namespace (otel-demo)
 * ARE the intended mutation, not a reversible-with-snapshot tier-2
 * action. The revert on scenario end happens via the Undo callable,
 * not via SLO-watch auto-revert.
 */

import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import type { FlagdFlagInjector, Scenario } from '../types/index.js';
import type { InjectorRunner, Undo } from './types.js';

const DEFAULT_CONFIG_KEY = 'demo.flagd.json';

export class FlagdFlagInjectorRunner
  implements InjectorRunner<FlagdFlagInjector>
{
  readonly type = 'flagd-flag' as const;

  constructor(private readonly client: ClusterClient) {}

  async inject(_scenario: Scenario, injector: FlagdFlagInjector): Promise<Undo> {
    const cmName = injector.target.configmap ?? 'flagd-config';
    const configKey = injector.config_key ?? DEFAULT_CONFIG_KEY;

    const cmRef = {
      kind: 'ConfigMap' as const,
      namespace: injector.target.ns,
      name: cmName,
    };

    const cm = await this.client.get(cmRef);
    const data = (cm as { data?: Record<string, string> }).data;
    if (!data || typeof data[configKey] !== 'string') {
      throw new Error(
        `flagd-flag injector: ConfigMap ${cmRef.namespace}/${cmRef.name} has no data[${configKey}]`,
      );
    }

    const originalJson = data[configKey];
    const flagdDoc = JSON.parse(originalJson) as FlagdDocument;

    if (!flagdDoc.flags || !flagdDoc.flags[injector.flag]) {
      throw new Error(
        `flagd-flag injector: flag "${injector.flag}" not found in flagd config ` +
          `(available: ${Object.keys(flagdDoc.flags ?? {}).slice(0, 10).join(', ')}…)`,
      );
    }
    const flag = flagdDoc.flags[injector.flag];
    if (!(injector.variant in flag.variants)) {
      throw new Error(
        `flagd-flag injector: variant "${injector.variant}" not valid for flag "${injector.flag}" ` +
          `(available: ${Object.keys(flag.variants).join(', ')})`,
      );
    }

    flag.defaultVariant = injector.variant;
    const mutatedCm = {
      ...cm,
      data: { ...data, [configKey]: JSON.stringify(flagdDoc, null, 2) },
    };

    await this.client.apply(cmRef, mutatedCm);

    // Undo: restore the original JSON verbatim.
    return async () => {
      const nowCm = await this.client.get(cmRef);
      const nowData = (nowCm as { data?: Record<string, string> }).data ?? {};
      const restoredCm = {
        ...nowCm,
        data: { ...nowData, [configKey]: originalJson },
      };
      await this.client.apply(cmRef, restoredCm);
    };
  }
}

// ── flagd document shape (minimal subset we need) ───────────────────

interface FlagdDocument {
  flags: Record<string, FlagdFlag>;
  $schema?: string;
}

interface FlagdFlag {
  state: 'ENABLED' | 'DISABLED';
  defaultVariant: string;
  variants: Record<string, unknown>;
  [other: string]: unknown;
}
