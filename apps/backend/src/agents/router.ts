// Router v2 (docs/09 §1.3). Rules veto obvious human work; the model decides the rest with a confidence; rules are the fallback.
import type { AgentName } from '@meetpilot/shared';
import { classifyTask, type Category } from './classify.js';

export const MIN_CONFIDENCE = 0.6;
export interface Plan {
  agent: AgentName | null; category: Category; reason: string; confidence: number | null;
  stagePlan: { stages: { agent: AgentName; goal: string }[]; scope: 'deliverable' | 'build'; suggestedAgent?: AgentName | null; missingInputs?: string[]; webPage?: boolean } | null;
}
interface ModelRoute {
  category: Category; agent: AgentName | null; stages: { agent: AgentName; goal: string }[]; scope: 'deliverable' | 'build';
  can_ai_do: boolean; confidence: number; reason: string; human_reason: string; missing_inputs: string[]; web_page?: boolean;
}

/** `ask` calls the AI service's /route; it may throw (service down, no key, mock mode). */
export async function routeTask(task: { title: string; description: string | null }, ask: () => Promise<ModelRoute>): Promise<Plan> {
  const rules = classifyTask(task.title, task.description);
  // Obvious human work (calls, payments, hiring, legal…) is never sent to an agent, whatever the model thinks.
  if (!rules.agent && /^Needs a person/.test(rules.reason)) return { agent: null, category: 'general', reason: rules.reason, confidence: 1, stagePlan: null };
  let m: ModelRoute;
  try { m = await ask(); } catch {
    return { agent: rules.agent, category: rules.category, reason: rules.reason, confidence: rules.agent ? 0.7 : null,
             stagePlan: rules.agent ? { stages: [{ agent: rules.agent, goal: task.title }], scope: 'deliverable' } : null };
  }
  const stagePlan = m.stages.length ? { stages: m.stages, scope: m.scope, missingInputs: m.missing_inputs, ...(m.web_page ? { webPage: true } : {}) } : null;
  if (!m.agent || !m.can_ai_do) {
    return { agent: null, category: m.category, reason: m.human_reason || m.reason || 'No specialist agent fits this task', confidence: m.confidence, stagePlan: null };
  }
  if (m.confidence < MIN_CONFIDENCE) {
    // Not sure enough to spend a run: leave it for a human, but offer the best guess as a one-click override.
    const why = m.missing_inputs.length ? `Not sure which agent fits; needs: ${m.missing_inputs.join('; ')}` : (m.reason || 'Not sure which agent fits');
    return { agent: null, category: m.category, reason: `${why} (best guess: ${m.agent})`, confidence: m.confidence, stagePlan: { stages: m.stages, scope: m.scope, suggestedAgent: m.agent, missingInputs: m.missing_inputs } };
  }
  return { agent: m.agent, category: m.category, reason: m.reason || `Looks like a ${m.category} task`, confidence: m.confidence, stagePlan };
}
