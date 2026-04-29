/**
 * operator/src/breakage — client library for the breakage runner.
 *
 * Imported by the agent loop for pre-action retrieval and by the
 * postmortem tool for reporting captured postmortems. No-op
 * gracefully when BREAKAGE_RUNNER_URL is unset.
 *
 * See client.ts for the public API.
 */

export {
  retrievePast,
  reportPostmortem,
  reportHypothesis,
  isBreakageEnabled,
  type RetrievalHit,
  type RetrieveOpts,
  type EmilyPostmortem,
  type EmilyHypothesis,
  type ReportPostmortemResult,
  type ReportHypothesisResult,
} from './client.js';
export {
  matchPlaybook,
  renderPlaybook,
  type Playbook,
  type PlaybookMatch,
} from './playbooks.js';
export { renderVocabSection } from './vocab.js';
