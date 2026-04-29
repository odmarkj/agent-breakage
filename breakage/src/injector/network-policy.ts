/**
 * network-policy injector. Applies a NetworkPolicy with the
 * scenario-provided spec into the target namespace. Used for
 * scenarios that exercise network-isolation failure modes: pods
 * can't reach the DB, can't reach DNS, one service is cut off
 * from another.
 *
 * Undo removes the NetworkPolicy.
 */

import * as k8s from '@kubernetes/client-node';
import type { ClusterClient } from '../speculative-exec/cluster-client.js';
import type { NetworkPolicyInjector, Scenario } from '../types/index.js';
import type { InjectorRunner, Undo } from './types.js';

const POLICY_NAME = 'breakage-injected-netpol';

export class NetworkPolicyInjectorRunner
  implements InjectorRunner<NetworkPolicyInjector>
{
  readonly type = 'network-policy' as const;
  private readonly networkingV1: k8s.NetworkingV1Api;

  constructor(_client: ClusterClient) {
    const kc = new k8s.KubeConfig();
    const override = process.env.BREAKAGE_KUBECONFIG;
    if (override) kc.loadFromFile(override);
    else kc.loadFromDefault();
    this.networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api);
  }

  async inject(scenario: Scenario, injector: NetworkPolicyInjector): Promise<Undo> {
    const ns = injector.target.ns;

    const manifest: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: POLICY_NAME,
        namespace: ns,
        labels: {
          'breakage.k3s.io/scenario': scenario.id,
          'breakage.k3s.io/injected': 'true',
        },
      },
      spec: injector.spec as k8s.V1NetworkPolicySpec,
    };

    try {
      await this.networkingV1.createNamespacedNetworkPolicy({
        namespace: ns,
        body: manifest,
      });
    } catch (err) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (code === 409) {
        // Already exists — replace it.
        await this.networkingV1.replaceNamespacedNetworkPolicy({
          name: POLICY_NAME,
          namespace: ns,
          body: manifest,
        });
      } else {
        throw err;
      }
    }

    return async () => {
      try {
        await this.networkingV1.deleteNamespacedNetworkPolicy({
          name: POLICY_NAME,
          namespace: ns,
        });
      } catch (err) {
        const code = (err as { code?: number; statusCode?: number }).code
          ?? (err as { statusCode?: number }).statusCode;
        if (code !== 404) throw err;
      }
    };
  }
}
