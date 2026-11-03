// Pull requests from verified Code agent changes (docs/09 §2.5). Pure helpers: the branch name, the default description and the eligibility checks.
import type { PrCheck } from '@meetpilot/shared';

const clean = (s: unknown, n: number) => String(s ?? '').replace(/[\r\n|`<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** meetpilot/<slug>-<short id>[-r<revision>] : always under our prefix, never an existing or default branch. */
export function branchName(title: string, executionId: string, revision: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/g, '') || 'change';
  const id = executionId.replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase() || '00000000';
  return `meetpilot/${slug}-${id}${revision > 0 ? `-r${revision}` : ''}`;
}

/** What goes into the PR description by default. Deliberately contains NO meeting content: the repository may be public. The reviewer sees and can edit it before anything is created. */
export function defaultPrBody(a: { summary: string | null; files: { path: string; status: string; additions: number; deletions: number }[]; verification: any }): string {
  const v = a.verification ?? {};
  const lines: string[] = ['## What', clean(a.summary, 600) || 'See the diff.', '', '## Files changed', ...a.files.slice(0, 12).map((f) => `- \`${clean(f.path, 120)}\` (${f.status}, +${Number(f.additions) || 0} −${Number(f.deletions) || 0})`), '', '## Verification'];
  if (v.status === 'verified') {
    const steps: any[] = Array.isArray(v.steps) ? v.steps : [];
    const t = [...steps].reverse().find((s) => s.label === 'tests');
    lines.push(`Verified in an isolated sandbox${v.ecosystem ? ` (${clean(v.ecosystem, 20)})` : ''}: the tests ran and passed${t?.counts?.passed != null ? ` (${Number(t.counts.passed)} passed)` : ''}.`);
    if (v.red_exit != null) lines.push(`The new tests ${v.red_exit !== 0 ? 'failed' : 'passed'} before the change and ${v.green_exit === 0 ? 'passed' : 'failed'} after it.`);
    for (const w of Array.isArray(v.warnings) ? v.warnings.slice(0, 4) : []) lines.push(`- Note: ${clean(w, 200)}`);
  } else lines.push('Not verified.');
  lines.push('', '<sub>Prepared by a MeetPilot agent and approved by a reviewer in MeetPilot. Nothing was merged automatically; please review before merging.</sub>');
  return lines.join('\n').slice(0, 19_000);
}

export interface PrFacts {
  status: string; verification: { status?: string; reason?: string } | null; repoId: string | null; canPush: boolean | null; githubConnected: boolean;
  hasFiles: boolean; baseSha: string | null; alreadyOpened: boolean;
}

/** Every precondition, each with its own explanation, so the page can say exactly why a pull request is not available. */
export function prChecks(f: PrFacts): PrCheck[] {
  const vs = f.verification?.status;
  return [
    { key: 'approved', label: 'You approved this change', ok: f.status === 'approved', detail: f.status === 'approved' ? undefined : 'Approve the change first.' },
    { key: 'verified', label: 'It passed verification in the sandbox', ok: vs === 'verified',
      detail: vs === 'verified' ? undefined : vs === 'failed' ? `Verification failed: ${clean(f.verification?.reason, 200)}` : `Not verified: ${clean(f.verification?.reason, 200) || 'the change was not tested in a sandbox'}. A pull request is only offered for verified changes.` },
    { key: 'repo', label: 'The repository is linked to the project', ok: !!f.repoId, detail: f.repoId ? undefined : 'No linked repository was used for this change.' },
    { key: 'github', label: 'GitHub access with write permission', ok: f.githubConnected && f.canPush === true,
      detail: !f.githubConnected ? 'Connect a GitHub token with Contents and Pull requests write access in project settings.' : f.canPush === true ? undefined : 'The token can read this repository but not push to it. Check its permissions, then refresh the repository.' },
    { key: 'files', label: 'The verified files are available', ok: f.hasFiles && !!f.baseSha, detail: f.hasFiles && f.baseSha ? undefined : 'This change was produced before pull requests were supported; ask the agent to redo it.' },
    { key: 'new', label: 'No pull request has been opened yet', ok: !f.alreadyOpened, detail: f.alreadyOpened ? 'A pull request was already opened for this change.' : undefined },
  ];
}
