/**
 * configmap-patch injector. Identical shape to deployment-patch:
 * parses a dotted-path mutation string, applies it to a ConfigMap's
 * JSON-serializable representation, writes back.
 *
 * Typical use cases: tweaking app config, patching feature flags
 * outside flagd, simulating a bad configmap update that drives a
 * deployment restart via a watch.
 *
 * For ConfigMaps, the `data` and `binaryData` fields are both
 * maps of strings. The mutation parser handles nested paths,
 * e.g.:
 *   mutation: data.log_level = "DEBUG"
 *   mutation: data.feature_flags.experimental = "false"
 *
 * The second form only works if the config value at that key is
 * JSON (an app that reads the key as a JSON blob). For flat-string
 * values, use the first form.
 */

import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import type { ConfigmapPatchInjector, Scenario } from '../types/index.js';
import { applyMutation, parseMutation } from './mutation-parser.js';
import type { InjectorRunner, Undo } from './types.js';

export class ConfigmapPatchInjectorRunner
  implements InjectorRunner<ConfigmapPatchInjector>
{
  readonly type = 'configmap-patch' as const;

  constructor(private readonly client: ClusterClient) {}

  async inject(_scenario: Scenario, injector: ConfigmapPatchInjector): Promise<Undo> {
    const target = {
      kind: 'ConfigMap' as const,
      namespace: injector.target.ns,
      name: injector.target.configmap ?? injector.target.cm ?? '',
    };
    if (!target.name) {
      throw new Error(
        `configmap-patch injector requires target.configmap or target.cm (got ${JSON.stringify(injector.target)})`,
      );
    }

    const pre = await this.client.get(target);
    const preSnapshot: Record<string, unknown> = JSON.parse(JSON.stringify(pre));

    const mutated: Record<string, unknown> = JSON.parse(JSON.stringify(pre));
    applyMutation(mutated, parseMutation(injector.mutation));

    await this.client.apply(target, mutated);

    return async () => {
      await this.client.apply(target, preSnapshot);
    };
  }
}
