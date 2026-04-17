import type { RegistryEntry } from "./types.js";
interface MentionMap {
    pattern: RegExp;
    replacement: string;
}
/**
 * Build a list of name→mention mappings from the agent registry.
 * Each agent can be referenced by agentId, agentName, or description keywords.
 */
export declare function buildMentionMap(agents: RegistryEntry[]): MentionMap[];
/**
 * Add custom name→mention entries (e.g., user names from project context).
 */
export declare function addCustomMentions(maps: MentionMap[], entries: Array<{
    name: string;
    discordId: string;
}>): MentionMap[];
/**
 * Replace agent names in text with Discord <@ID> mentions.
 * Skips text already in mention format.
 */
export declare function applyMentions(text: string, maps: MentionMap[]): string;
export {};
