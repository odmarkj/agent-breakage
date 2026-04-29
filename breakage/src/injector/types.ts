/**
 * Injector interface.
 *
 * An injector takes a validated scenario, applies the fault to the
 * k3d-scenarios cluster, and returns an Undo callable that the runner
 * invokes at scenario end to reset the environment. The undo doesn't
 * have to perfectly restore pre-scenario state — that's what the
 * ephemeral namespace model handles — but it should stop the fault
 * from bleeding into subsequent scenarios.
 */

import type { Injector, Scenario } from '../types/index.js';

export type Undo = () => Promise<void>;

export interface InjectorRunner<TInjector extends Injector = Injector> {
  /** The discriminator value this runner handles. */
  readonly type: TInjector['type'];
  /** Apply the fault. Returns an undo callable. */
  inject(scenario: Scenario, injector: TInjector): Promise<Undo>;
}
