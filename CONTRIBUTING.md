# Contributing

This is a research-grade reference implementation accompanying a forthcoming methodology paper. The codebase is intended to be reproducible and forkable; it is not a long-term-supported product.

## What's in scope

- **New scenarios.** The framework is most valuable when its scenario library grows. Authoring guide: [`breakage/docs/authoring-scenarios.md`](breakage/docs/authoring-scenarios.md). PRs adding scenarios that exercise common Kubernetes failure modes are welcome.
- **Bug reports.** If the falsification reproducer doesn't land within ±5pp on your machine, open an issue with the env diff. Reproducibility is the bar.
- **Doc fixes.** Typos, broken links, unclear sections. Always welcome.
- **Detector / scorer extensions.** New detector expression types or scoring axes that fit the four-axis framing. Discuss in an issue first.

## What's out of scope

- **Replacing the agent (`operator/`).** Emily is one specific implementation. The framework's hypothesis-testing scaffolding is agent-agnostic; if you want to swap the agent under test, fork or open a discussion.
- **Production-readiness changes.** This isn't a production tool. PRs framed as "making this production-ready" will likely be declined.
- **Renaming or restructuring.** The published paper cites this repo at specific paths; structural churn breaks reproducibility.

## How to propose a change

1. Open an issue describing what and why before writing code, especially for non-trivial changes.
2. For scenarios: include a YAML scenario file plus a brief writeup of what failure mode it exercises and what the expected agent behavior is.
3. PRs should include a reproduced run on the contributor's machine — paste the relevant scorecard or report.

## Code of conduct

Be useful to other readers and contributors. Substantive disagreement on technical claims is welcome; treat the artifacts as the thing under discussion, not the people discussing them.

## Maintainer

Joshua Odmark · `joshua.odmark@gmail.com` · [@odmarkj](https://github.com/odmarkj)

Response time is not guaranteed; this is an independent research project. Issues and PRs may sit for a few weeks before review.
