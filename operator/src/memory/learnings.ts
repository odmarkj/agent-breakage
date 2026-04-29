import { readFileSync, writeFileSync, renameSync, watch, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { getProvider } from '../provider/index.js';

/**
 * Operator learning memory: Emily's own evolving knowledge base.
 *
 * Inspired by the curated-context plugin's architecture:
 * - Confidence decay (exponential then power-law)
 * - Topic-key upsert (same topic updates in place)
 * - File-based storage (human-inspectable markdown)
 *
 * Stored in operator/data/learnings/emily-learnings.md
 * Separate from the human-managed context/ folder.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface Learning {
  id: string;
  topic: string;
  insight: string;
  confidence: number;
  source: string; // goal ID
  successCount: number;
  revisionCount: number;
  createdAt: number; // Unix ms
  updatedAt: number;
  lastAccessed: number;
}

// ── Decay constants (from curated-context) ─────────────────────────────

const EXPONENTIAL_LAMBDA = 0.01; // per hour, gentler than curated-context's 0.02
const POWER_LAW_EXPONENT = -0.2;
const DECAY_FLOOR = 0.05;
const EXPONENTIAL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EVICTION_DAYS = 30;

// ── State ──────────────────────────────────────────────────────────────

let _learnings: Map<string, Learning> = new Map();
let _dir: string;
let _filePath: string;

// ── Initialization ─────────────────────────────────────────────────────

export function initLearningMemory(dataDir?: string): void {
  _dir = dataDir ?? resolve(process.cwd(), 'data', 'learnings');
  mkdirSync(_dir, { recursive: true });
  _filePath = resolve(_dir, 'emily-learnings.md');
  loadFromFile();

  try {
    watch(_dir, (_eventType, filename) => {
      if (filename && extname(filename) === '.md') {
        loadFromFile();
      }
    });
  } catch {
    // watch may not be supported
  }
}

// ── Confidence decay ───────────────────────────────────────────────────

export function computeEffectiveConfidence(learning: Learning, now = Date.now()): number {
  const msSinceAccess = now - (learning.lastAccessed || learning.updatedAt);
  if (msSinceAccess <= 0) return learning.confidence;

  let decayFactor: number;

  if (msSinceAccess < EXPONENTIAL_THRESHOLD_MS) {
    const hours = msSinceAccess / (60 * 60 * 1000);
    decayFactor = Math.exp(-EXPONENTIAL_LAMBDA * hours);
  } else {
    const days = msSinceAccess / (24 * 60 * 60 * 1000);
    decayFactor = Math.pow(days, POWER_LAW_EXPONENT);
  }

  return Math.max(learning.confidence * decayFactor, DECAY_FLOOR);
}

// ── Core API ───────────────────────────────────────────────────────────

/** Record or update a learning. Upserts by topic key. */
export function recordLearning(topic: string, insight: string, sourceGoalId: string): Learning {
  const now = Date.now();
  const normalizedTopic = topic.toLowerCase().replace(/[\s_]+/g, '-');

  // Topic-key upsert: check if we already have a learning on this topic
  let existing: Learning | undefined;
  for (const l of _learnings.values()) {
    if (l.topic === normalizedTopic) {
      existing = l;
      break;
    }
  }

  if (existing) {
    // Update in place — boost confidence, update insight
    existing.insight = insight;
    existing.confidence = Math.min(existing.confidence + 0.1, 1.0);
    existing.updatedAt = now;
    existing.lastAccessed = now;
    existing.revisionCount += 1;
    existing.source = sourceGoalId;
    saveToFile();
    return existing;
  }

  // New learning
  const learning: Learning = {
    id: `learn_${now}_${Math.random().toString(36).slice(2, 8)}`,
    topic: normalizedTopic,
    insight,
    confidence: 0.7,
    source: sourceGoalId,
    successCount: 0,
    revisionCount: 1,
    createdAt: now,
    updatedAt: now,
    lastAccessed: now,
  };

  _learnings.set(learning.id, learning);
  saveToFile();
  return learning;
}

/** Mark a learning as having contributed to a successful outcome. */
export function reinforceLearning(id: string): void {
  const learning = _learnings.get(id);
  if (!learning) return;
  learning.successCount += 1;
  learning.confidence = Math.min(learning.confidence + 0.05, 1.0);
  learning.lastAccessed = Date.now();
  saveToFile();
}

/** Get learnings relevant to a query, sorted by effective confidence. */
export function getLearningsForPrompt(query?: string, maxTokens = 2000): string {
  const now = Date.now();
  const MIN_CONFIDENCE = 0.1;

  let candidates = [..._learnings.values()]
    .filter((l) => computeEffectiveConfidence(l, now) >= MIN_CONFIDENCE);

  // Simple keyword relevance scoring
  if (query) {
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    candidates = candidates.map((l) => {
      const text = `${l.topic} ${l.insight}`.toLowerCase();
      const matches = queryWords.filter((w) => text.includes(w)).length;
      return { ...l, _relevance: matches };
    }).sort((a, b) => {
      const aScore = (a as any)._relevance * 10 + computeEffectiveConfidence(a, now);
      const bScore = (b as any)._relevance * 10 + computeEffectiveConfidence(b, now);
      return bScore - aScore;
    });
  } else {
    candidates.sort((a, b) => computeEffectiveConfidence(b, now) - computeEffectiveConfidence(a, now));
  }

  // Build output within token budget (~4 chars per token)
  const lines: string[] = [];
  let charCount = 0;
  const charBudget = maxTokens * 4;

  for (const l of candidates) {
    const conf = computeEffectiveConfidence(l, now).toFixed(2);
    const line = `- **${l.topic}** (confidence: ${conf}, used ${l.successCount}x): ${l.insight}`;
    if (charCount + line.length > charBudget && lines.length > 0) break;
    lines.push(line);
    charCount += line.length;

    // Touch accessed learnings (resets decay clock)
    const original = _learnings.get(l.id);
    if (original) original.lastAccessed = now;
  }

  if (lines.length === 0) return '';
  saveToFile(); // Persist the lastAccessed updates
  return `## Operator Learnings\n${lines.join('\n')}\n`;
}

/** Apply decay and evict stale learnings. Called by consolidator. */
export function decayLearnings(): void {
  const now = Date.now();
  const evictionCutoff = now - EVICTION_DAYS * 24 * 60 * 60 * 1000;

  for (const [id, l] of _learnings) {
    const eff = computeEffectiveConfidence(l, now);
    if (eff <= DECAY_FLOOR && l.lastAccessed < evictionCutoff) {
      _learnings.delete(id);
    }
  }

  saveToFile();
}

/** Get all learnings (for inspection/debugging). */
export function getAllLearnings(): Learning[] {
  return [..._learnings.values()];
}

// ── Learning extraction from goal outcomes ─────────────────────────────

/**
 * After a goal completes, extract reusable learnings from the outcome.
 * Uses a cheap Haiku call to identify what's worth remembering.
 */
export async function extractAndStoreLearnings(
  goalId: string,
  goalTitle: string,
  outcome: string,
): Promise<void> {
  if (!outcome || outcome.length < 50) return;

  const provider = getProvider('low');

  try {
    const response = await provider.classify(
      `You are analyzing the outcome of an autonomous Kubernetes cluster investigation.

Goal: ${goalTitle}
Outcome:
${outcome.slice(0, 3000)}

Extract 0-3 reusable learnings that would help investigate SIMILAR future issues.
Only include insights that are general and reusable, NOT one-off findings.
Good examples: "PostgreSQL in this cluster runs as a StatefulSet in platform namespace with headless service"
Bad examples: "Pod postgres-0 was running at 10:32 AM"

If the investigation found nothing actionable or the issue resolved itself, return NONE.

Format each learning as:
TOPIC: short-kebab-case-topic
INSIGHT: one sentence description

If no learnings, respond with just: NONE`,
    );

    if (response.trim() === 'NONE' || !response.includes('TOPIC:')) return;

    // Parse learnings from response
    const learningBlocks = response.split('TOPIC:').slice(1);
    for (const block of learningBlocks) {
      const topicMatch = block.match(/^([^\n]+)/);
      const insightMatch = block.match(/INSIGHT:\s*(.+)/);
      if (topicMatch && insightMatch) {
        const topic = topicMatch[1].trim();
        const insight = insightMatch[1].trim();
        if (topic && insight) {
          recordLearning(topic, insight, goalId);
        }
      }
    }
  } catch {
    // LLM call failed, skip learning extraction
  }
}

// ── File I/O ───────────────────────────────────────────────────────────

function saveToFile(): void {
  if (!_filePath) return;

  const lines: string[] = [
    '---',
    '# Emily\'s Learnings - Auto-generated, do not edit manually',
    '# Emily updates this file as she learns from investigating cluster issues.',
    '# Confidence decays over time; frequently-useful learnings stay strong.',
    '---',
    '',
  ];

  const sorted = [..._learnings.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  for (const l of sorted) {
    lines.push(`## ${l.topic}`);
    lines.push(`<!-- id:${l.id} confidence:${l.confidence} success:${l.successCount} revisions:${l.revisionCount} source:${l.source} created:${l.createdAt} updated:${l.updatedAt} accessed:${l.lastAccessed} -->`);
    lines.push(l.insight);
    lines.push('');
  }

  const tmpPath = _filePath + '.tmp';
  writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
  renameSync(tmpPath, _filePath);
}

function loadFromFile(): void {
  _learnings.clear();

  try {
    const content = readFileSync(_filePath, 'utf-8');
    const sections = content.split(/^## /m).slice(1); // Skip frontmatter

    for (const section of sections) {
      const topicLine = section.split('\n')[0]?.trim();
      const metaMatch = section.match(
        /<!-- id:(\S+) confidence:([\d.]+) success:(\d+) revisions:(\d+) source:(\S+) created:(\d+) updated:(\d+) accessed:(\d+) -->/,
      );
      const insightLines = section.split('\n').slice(2).join('\n').trim();

      if (topicLine && metaMatch && insightLines) {
        const learning: Learning = {
          id: metaMatch[1],
          topic: topicLine,
          insight: insightLines,
          confidence: parseFloat(metaMatch[2]),
          successCount: parseInt(metaMatch[3], 10),
          revisionCount: parseInt(metaMatch[4], 10),
          source: metaMatch[5],
          createdAt: parseInt(metaMatch[6], 10),
          updatedAt: parseInt(metaMatch[7], 10),
          lastAccessed: parseInt(metaMatch[8], 10),
        };
        _learnings.set(learning.id, learning);
      }
    }
  } catch {
    // File doesn't exist yet, start fresh
  }
}
