/**
 * Injector registry. Resolves an injector type discriminator to its
 * runner implementation. Keeps the runner orchestrator free of
 * type-specific branching.
 *
 * Full registry as of Phase 1 completion: deployment-patch,
 * flagd-flag, secret-content, configmap-patch, pod-evict,
 * network-policy.
 */

import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import type { Injector, Scenario } from '../types/index.js';
import { DeploymentPatchInjectorRunner } from './deployment-patch.js';
import { FlagdFlagInjectorRunner } from './flagd-flag.js';
import { SecretContentInjectorRunner } from './secret-content.js';
import { ConfigmapPatchInjectorRunner } from './configmap-patch.js';
import { PodEvictInjectorRunner } from './pod-evict.js';
import { NetworkPolicyInjectorRunner } from './network-policy.js';
import type { InjectorRunner, Undo } from './types.js';

export class InjectorRegistry {
  private readonly runners = new Map<string, InjectorRunner>();

  constructor(client: ClusterClient) {
    this.register(new DeploymentPatchInjectorRunner(client));
    this.register(new FlagdFlagInjectorRunner(client));
    this.register(new SecretContentInjectorRunner(client));
    this.register(new ConfigmapPatchInjectorRunner(client));
    this.register(new PodEvictInjectorRunner(client));
    this.register(new NetworkPolicyInjectorRunner(client));
  }

  register(runner: InjectorRunner): void {
    this.runners.set(runner.type, runner);
  }

  async inject(scenario: Scenario): Promise<Undo> {
    const injector = scenario.injector as Injector & { type: string };
    const runner = this.runners.get(injector.type);
    if (!runner) {
      throw new Error(
        `no injector runner registered for type "${injector.type}" (scenario ${scenario.id})`,
      );
    }
    // runner.inject is typed against the narrow injector shape; the
    // registry-level signature erases that for the lookup, so cast.
    return runner.inject(scenario, injector as never);
  }
}
