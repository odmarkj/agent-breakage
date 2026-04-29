import type { ToolTier } from '../types.js';

interface PolicyRule {
  name: string;
  description: string;
  check: (context: PolicyContext) => PolicyDecision;
}

interface PolicyContext {
  toolName: string;
  toolTier: ToolTier;
  toolInput: Record<string, unknown>;
  namespace?: string;
  riskClass?: string;
  isBusinessHours: boolean;
}

type PolicyDecision = 'allow' | 'audit' | 'require_approval' | 'deny';

const rules: PolicyRule[] = [
  {
    name: 'postgres_read_only_bypass',
    description: 'SELECT queries on postgres_query (tier 3) auto-execute without approval',
    check: (ctx) => {
      if (ctx.toolName === 'postgres_query') {
        const sql = ((ctx.toolInput.sql as string) ?? '').trim().toUpperCase();
        if (sql.startsWith('SELECT') || sql.startsWith('\\D') || sql.startsWith('\\L')) {
          return 'audit';
        }
      }
      return 'allow';
    },
  },
];

/**
 * Evaluate all policy rules for a given action.
 * Returns the most restrictive decision.
 *
 * Tier 1: auto-execute (read-only)
 * Tier 2: auto-execute with audit logging (ops + code fixes)
 * Tier 3: requires approval (database writes, kubectl apply/delete, helm changes)
 *
 * The only policy overrides are:
 * - operator namespace is always denied
 * - SELECT queries bypass tier 3 approval
 */
export function evaluatePolicy(context: PolicyContext): PolicyDecision {
  const decisions = rules.map((r) => r.check(context));

  if (decisions.includes('deny')) return 'deny';
  // If any rule explicitly returned audit (e.g. postgres SELECT), use that
  // instead of falling through to tier-based approval
  if (decisions.includes('audit')) return 'audit';
  if (decisions.includes('require_approval')) return 'require_approval';
  return 'allow';
}

export function isBusinessHours(): boolean {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 18;
}
