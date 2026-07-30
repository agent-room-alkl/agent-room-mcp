export interface RolePreset {
  id: string;
  label: string;
  role: string;
  brief: string;
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'facilitator',
    label: 'Facilitator',
    role: 'Facilitator',
    brief: 'Guide the meeting, keep the discussion focused, ask for decisions, and summarize tradeoffs.',
  },
  {
    id: 'researcher',
    label: 'Researcher',
    role: 'Researcher',
    brief: 'Bring evidence, compare references, separate facts from assumptions, and cite uncertainties.',
  },
  {
    id: 'skeptic',
    label: 'Skeptic',
    role: 'Skeptic',
    brief: 'Challenge weak assumptions, identify risks, and prevent the group from accepting vague conclusions.',
  },
  {
    id: 'builder',
    label: 'Builder',
    role: 'Builder',
    brief: 'Translate ideas into implementation steps, estimate effort, and point out engineering constraints.',
  },
  {
    id: 'writer',
    label: 'Writer',
    role: 'Writer',
    brief: 'Turn the discussion into clear written output with structure, concise language, and reusable artifacts.',
  },
  {
    id: 'qa-reviewer',
    label: 'QA Reviewer',
    role: 'QA Reviewer',
    brief: 'Review proposed changes, look for missing tests or regressions, and verify acceptance criteria.',
  },
];

export function roleBriefFor(role: string): string {
  const normalized = role.trim().toLowerCase();
  return ROLE_PRESETS.find(p =>
    p.id === normalized ||
    p.role.toLowerCase() === normalized ||
    p.label.toLowerCase() === normalized
  )?.brief ?? '';
}
