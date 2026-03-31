import type { RegistryEntry } from "./types.js";

interface MentionMap {
  pattern: RegExp;
  replacement: string;
}

/**
 * Build a list of name→mention mappings from the agent registry.
 * Each agent can be referenced by agentId, agentName, or description keywords.
 */
export function buildMentionMap(agents: RegistryEntry[]): MentionMap[] {
  const maps: MentionMap[] = [];

  for (const agent of agents) {
    if (!agent.discordId) continue;

    const mention = `<@${agent.discordId}>`;
    const names = new Set<string>();

    // Always match agentId and agentName
    names.add(agent.agentId);
    if (agent.agentName) names.add(agent.agentName);

    // Build regex: match any of the names, word-bounded
    // Sort by length descending so longer names match first
    const sorted = [...names].filter(n => n.length >= 2).sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      // Skip if name is already a Discord mention format
      if (name.startsWith("<@")) continue;
      // Escape regex special chars
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      maps.push({
        pattern: new RegExp(`(?<!<@[!&]?)\\b${escaped}\\b`, "gi"),
        replacement: mention,
      });
    }
  }

  return maps;
}

/**
 * Replace agent names in text with Discord <@ID> mentions.
 * Skips text already in mention format.
 */
export function applyMentions(text: string, maps: MentionMap[]): string {
  let result = text;
  for (const { pattern, replacement } of maps) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
