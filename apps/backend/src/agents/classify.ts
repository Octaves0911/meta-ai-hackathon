// Rules-based task router (docs/04 §6). Decides whether an AI can do a task and which specialist should.
import type { AgentName } from '@meetpilot/shared';

export type Category = 'code' | 'marketing' | 'design' | 'communication' | 'research' | 'general';
export interface Classification { category: Category; agent: AgentName | null; reason: string }

// Things that need a person: calls, payments, hiring, legal sign-off, in-person work.
const HUMAN = /\b(call|phone|ring|pay|payment|invoice|wire|transfer|hire|hiring|interview|recruit|legal|lawyer|sign|notari[sz]e|in[- ]person|visit|book (?:the )?(?:venue|flight|hotel)|deliver|ship the package)\b/i;
const RULES: [Category, RegExp][] = [
  ['design', /\b(design|logo|mockup|mock-up|wireframe|banner|brand(?:ing)?|ui|ux|icon|poster|illustration)\b/i],
  ['communication', /\b(email|e-mail|reply|respond|write to|message|announce(?:ment)?|newsletter|follow[- ]up with|draft (?:a |the )?(?:note|letter))\b/i],
  ['marketing', /\b(campaign|marketing|go[- ]to[- ]market|gtm|positioning|seo|social media|launch plan|press release|pricing strategy)\b/i],
  ['code', /\b(implement|refactor|fix (?:the )?bug|bug|api|endpoint|database|schema|migration|deploy|feature|code|script|unit test|integration)\b/i],
  ['research', /\b(research|analy[sz]e|analysis|compare|comparison|investigate|benchmark|competitor|summari[sz]e|report|study|find out|look into|evaluate)\b/i],
];
const AGENT: Record<Exclude<Category, 'general'>, AgentName> = {
  code: 'code', marketing: 'marketing', design: 'designer', communication: 'communication', research: 'research',
};

export function classifyTask(title: string, description?: string | null): Classification {
  const text = `${title} ${description ?? ''}`;
  // Check the title first so the spoken sentence ("…by Friday") does not outvote what the task is.
  const human = HUMAN.exec(title) ?? HUMAN.exec(text);
  if (human) return { category: 'general', agent: null, reason: `Needs a person (“${human[0]}”)` };
  for (const src of [title, text]) {
    for (const [cat, re] of RULES) {
      if (re.test(src)) return { category: cat, agent: AGENT[cat as Exclude<Category, 'general'>], reason: `Looks like a ${cat} task` };
    }
  }
  return { category: 'general', agent: null, reason: 'No specialist agent fits this task' };
}
