// Who did this message address by name?
//
// Used to route a message to specific agents instead of the whole room:
// "@Claude 看下这个" should get one answer, not four. The same matching drives
// moderator assignments and host @-mentions, so it lives here rather than being
// re-implemented (slightly differently) at each call site.

/**
 * Agent names mentioned as `@Name` in `text`, in roster order.
 *
 * Matching is exact-first, then case-insensitive: people type "@claude" for an
 * agent named "Claude", and an unmatched mention used to mean the assignment
 * silently went nowhere. Callers decide what an empty result means — for host
 * messages it means "not addressed to anyone in particular", so they fall back
 * to waking the whole room rather than leaving it silent.
 */
export function mentionedAgents(text: string, agentNames: readonly string[]): string[] {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  return agentNames.filter(name =>
    text.includes(`@${name}`) || lowerText.includes(`@${name.toLowerCase()}`),
  );
}
