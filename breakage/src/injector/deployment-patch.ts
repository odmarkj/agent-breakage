/**
 * deployment-patch injector. Parses the mutation string, fetches the
 * current Deployment, applies the mutation, and writes back via the
 * cluster client. Returns an Undo that restores the pre-injection
 * manifest.
 */

import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import type { DeploymentPatchInjector, Scenario } from '../types/index.js';
import { applyMutation, parseMutation } from './mutation-parser.js';
import type { InjectorRunner, Undo } from './types.js';

export class DeploymentPatchInjectorRunner
  implements InjectorRunner<DeploymentPatchInjector>
{
  readonly type = 'deployment-patch' as const;

  constructor(private readonly client: ClusterClient) {}

  async inject(_scenario: Scenario, injector: DeploymentPatchInjector): Promise<Undo> {
    const target = {
      kind: 'Deployment' as const,
      namespace: injector.target.ns,
      name: injector.target.deploy ?? '',
    };
    if (!target.name) {
      throw new Error(
        `deployment-patch injector requires target.deploy (got ${JSON.stringify(injector.target)})`,
      );
    }

    const pre = await this.client.get(target);
    // Deep clone so undo has its own reference.
    const preSnapshot: Record<string, unknown> = JSON.parse(JSON.stringify(pre));

    const mutated: Record<string, unknown> = JSON.parse(JSON.stringify(pre));
    applyMutation(mutated, parseMutation(injector.mutation));

    await this.client.apply(target, mutated);

    return async () => {
      await this.client.apply(target, preSnapshot);
    };
  }
}
