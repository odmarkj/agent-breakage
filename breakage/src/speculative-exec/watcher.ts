/**
 * SLO-watch timer. Monitors a set of metric probes over a
 * configurable window, emitting a RegressionEvent the moment any
 * probe trips past its threshold.
 *
 * Abstracts the metric source behind MetricProbe so the same watcher
 * works with Prometheus, cluster state checks, or synthetic probes
 * during tests.
 */

import type { RegressionEvent, SloMetricDelta } from './types.js';
import { formatMechanicalReason } from './reason.js';

export interface MetricProbe {
  /** Label used in logs and the mechanical reason string. */
  readonly name: string;
  /** Threshold the delta must exceed to count as a regression. */
  readonly threshold: number;
  /**
   * Record the pre-mutation baseline. Called once before the
   * mutation runs.
   */
  captureBaseline(): Promise<number>;
  /**
   * Fetch the current value. Called repeatedly during the watch
   * window.
   */
  currentValue(): Promise<number>;
}

export interface WatchConfig {
  probes: MetricProbe[];
  /** Total watch window in milliseconds. Plan default: 15-60s per action class. */
  windowMs: number;
  /** How often to poll the probes. Default 2000ms. */
  pollIntervalMs?: number;
}

/**
 * Run the watch loop. Returns the first RegressionEvent observed
 * within the window, or null if the window elapses cleanly.
 *
 * Each probe is polled at pollIntervalMs; cancellation is immediate
 * on the first regression (no point continuing to poll).
 */
export async function watchForRegression(
  config: WatchConfig,
): Promise<RegressionEvent | null> {
  const pollInterval = config.pollIntervalMs ?? 2000;

  // Capture baselines in parallel.
  const baselines = await Promise.all(
    config.probes.map(async (p) => ({ probe: p, baseline: await p.captureBaseline() })),
  );

  const deadline = Date.now() + config.windowMs;

  while (Date.now() < deadline) {
    for (const { probe, baseline } of baselines) {
      const current = await probe.currentValue();
      const delta = current - baseline;

      if (delta > probe.threshold) {
        const sloDelta: SloMetricDelta = {
          metric: probe.name,
          before: baseline,
          after: current,
          delta,
          threshold: probe.threshold,
          exceededAt: new Date().toISOString(),
        };
        return {
          delta: sloDelta,
          mechanicalReason: formatMechanicalReason(sloDelta),
        };
      }
    }
    await sleep(pollInterval);
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
