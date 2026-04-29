#!/usr/bin/env python3
"""
Analyze the corpus-density sweep manifest produced by density-sweep.sh.

Input: /tmp/density-sweep-manifest.csv (or path passed as argv[1])
Output: per-(scenario, density, arm) summary, per-(scenario, density)
TEI-vs-control delta with Welch's t, pooled effects, plus a markdown
table block ready to paste into the corpus-density-sweep report.

Welch's t-test computed manually (no scipy dependency). Significance
thresholds approximated using normal-distribution critical values, valid
for df >= ~20 (exact for df = 38, the n=20-per-arm matched-pair case).
"""

from __future__ import annotations

import csv
import math
import sys
from collections import defaultdict
from statistics import mean, stdev


MANIFEST = sys.argv[1] if len(sys.argv) > 1 else '/tmp/density-sweep-manifest.csv'

# Approximate critical values (two-tailed) for df ~ 38.
# Used for quick "is this p<0.05 or p<0.01" labelling.
T_CRIT_05 = 2.024
T_CRIT_01 = 2.711


def welch_t(a: list[float], b: list[float]) -> tuple[float, float]:
    """Returns (t-statistic, df) for two-sample Welch's t-test."""
    if len(a) < 2 or len(b) < 2:
        return (0.0, 0.0)
    ma, mb = mean(a), mean(b)
    va, vb = stdev(a) ** 2, stdev(b) ** 2
    na, nb = len(a), len(b)
    se = math.sqrt(va / na + vb / nb)
    if se == 0:
        return (0.0, 0.0)
    t = (ma - mb) / se
    df = (va / na + vb / nb) ** 2 / (
        (va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1)
    )
    return (t, df)


def sig_label(t: float) -> str:
    a = abs(t)
    if a >= T_CRIT_01:
        return 'p<0.01'
    if a >= T_CRIT_05:
        return 'p<0.05'
    return 'ns'


def main() -> int:
    cells: dict[tuple[str, str, str], list[float]] = defaultdict(list)

    with open(MANIFEST) as f:
        reader = csv.DictReader(f)
        for row in reader:
            scenario = row['scenario']
            density = row['density']
            arm = row['arm']
            score_str = row.get('score', '').strip()
            if not score_str:
                continue
            try:
                score = float(score_str)
            except ValueError:
                continue
            cells[(scenario, density, arm)].append(score)

    if not cells:
        print(f'No data found in {MANIFEST}', file=sys.stderr)
        return 1

    # Group by scenario × density for matched-pair comparison.
    keys = sorted(set((s, d) for (s, d, _) in cells.keys()))

    # Per-scenario × density block.
    print(f'\n## Per-cell summary (manifest: {MANIFEST})\n')
    print(f"{'scenario':<45} {'density':>7} {'arm':>8} {'n':>3} {'mean':>6} {'sd':>6}")
    print('=' * 80)
    for (scenario, density) in keys:
        for arm in ('tei', 'control'):
            scores = cells.get((scenario, density, arm), [])
            if not scores:
                continue
            n = len(scores)
            m = mean(scores)
            s = stdev(scores) if n > 1 else 0.0
            print(f'{scenario:<45} {density:>7} {arm:>8} {n:>3} {m:>6.3f} {s:>6.3f}')

    # Per-scenario × density TEI-vs-control delta.
    print('\n## Per-(scenario, density) Δ TEI−control\n')
    print(f"{'scenario':<45} {'density':>7} "
          f"{'n_tei':>5} {'μ_tei':>6} {'n_ctrl':>6} {'μ_ctrl':>7} "
          f"{'Δ':>7} {'t':>6} {'sig':>8}")
    print('=' * 100)
    rows_for_md = []
    for (scenario, density) in keys:
        tei = cells.get((scenario, density, 'tei'), [])
        ctrl = cells.get((scenario, density, 'control'), [])
        if not tei or not ctrl:
            continue
        delta = mean(tei) - mean(ctrl)
        t, df = welch_t(tei, ctrl)
        sig = sig_label(t)
        print(f'{scenario:<45} {density:>7} '
              f'{len(tei):>5} {mean(tei):>6.3f} {len(ctrl):>6} {mean(ctrl):>7.3f} '
              f'{delta:>+7.3f} {t:>6.2f} {sig:>8}')
        rows_for_md.append({
            'scenario': scenario,
            'density': density,
            'n_tei': len(tei),
            'mean_tei': mean(tei),
            'sd_tei': stdev(tei) if len(tei) > 1 else 0.0,
            'n_ctrl': len(ctrl),
            'mean_ctrl': mean(ctrl),
            'sd_ctrl': stdev(ctrl) if len(ctrl) > 1 else 0.0,
            'delta': delta,
            't': t,
            'df': df,
            'sig': sig,
        })

    # Pooled by density tier (across scenarios).
    print('\n## Pooled by density tier\n')
    print(f"{'density':>7} "
          f"{'n_tei':>5} {'μ_tei':>6} {'sd_tei':>7} "
          f"{'n_ctrl':>6} {'μ_ctrl':>7} {'sd_ctrl':>8} "
          f"{'Δ':>7} {'t':>6} {'sig':>8}")
    print('=' * 90)
    pooled_rows = []
    for density in ('5', '15', 'full'):
        tei = []
        ctrl = []
        for (scenario, d, a), scores in cells.items():
            if d != density:
                continue
            if a == 'tei':
                tei += scores
            else:
                ctrl += scores
        if not tei or not ctrl:
            continue
        delta = mean(tei) - mean(ctrl)
        t, df = welch_t(tei, ctrl)
        sig = sig_label(t)
        sd_tei = stdev(tei) if len(tei) > 1 else 0.0
        sd_ctrl = stdev(ctrl) if len(ctrl) > 1 else 0.0
        print(f'{density:>7} '
              f'{len(tei):>5} {mean(tei):>6.3f} {sd_tei:>7.3f} '
              f'{len(ctrl):>6} {mean(ctrl):>7.3f} {sd_ctrl:>8.3f} '
              f'{delta:>+7.3f} {t:>6.2f} {sig:>8}')
        pooled_rows.append({
            'density': density,
            'n_tei': len(tei),
            'mean_tei': mean(tei),
            'sd_tei': sd_tei,
            'n_ctrl': len(ctrl),
            'mean_ctrl': mean(ctrl),
            'sd_ctrl': sd_ctrl,
            'delta': delta,
            't': t,
            'df': df,
            'sig': sig,
        })

    # Markdown-ready blocks for the report.
    print('\n## Markdown tables (paste into report)\n')
    print('### Per-scenario × density\n')
    print('| Scenario | Density | n_tei | μ_tei | σ_tei | n_ctrl | μ_ctrl | σ_ctrl | Δ | t | sig |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for r in rows_for_md:
        print(
            f'| `{r["scenario"]}` | {r["density"]} | '
            f'{r["n_tei"]} | {r["mean_tei"]:.3f} | {r["sd_tei"]:.3f} | '
            f'{r["n_ctrl"]} | {r["mean_ctrl"]:.3f} | {r["sd_ctrl"]:.3f} | '
            f'{r["delta"]:+.3f} | {r["t"]:.2f} | {r["sig"]} |'
        )

    print('\n### Pooled by density tier\n')
    print('| Density | n_tei | μ_tei | σ_tei | n_ctrl | μ_ctrl | σ_ctrl | Δ | t | sig |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for r in pooled_rows:
        print(
            f'| {r["density"]} | '
            f'{r["n_tei"]} | {r["mean_tei"]:.3f} | {r["sd_tei"]:.3f} | '
            f'{r["n_ctrl"]} | {r["mean_ctrl"]:.3f} | {r["sd_ctrl"]:.3f} | '
            f'{r["delta"]:+.3f} | {r["t"]:.2f} | {r["sig"]} |'
        )

    return 0


if __name__ == '__main__':
    sys.exit(main())
