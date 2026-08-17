// Single source of truth for tool DEFINITIONS (name → ToolDef), and the per-mode
// gating that turns a mode's tool-name list into the actual ToolDef[] handed to
// the model. Executors live in agent.ts (runTool) / agentTools.ts and dispatch
// by name, so they are unaffected by where the defs live.
import type { ToolDef } from './providers'
import { AGENT_ACTION_TOOLS } from './agentTools'
import type { AgentMode } from './modes'

// --- base read-tool defs (copies of agent.ts's BASE_TOOLS / LOAD_SKILL_TOOL) ---
const SEARCH_LIBRARY_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'search_library',
		description:
			'Hybrid semantic + keyword search over the full text of every paper in the current library. ' +
			'Returns excerpts with their source (item_key + seq). Call multiple times with different ' +
			'phrasings if the first search misses. Queries can be Chinese or English.',
		parameters: { type: 'object', properties: { query: { type: 'string', description: 'search query' } }, required: ['query'] },
	},
}
const GET_ITEM_INFO_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'get_item_info',
		description: 'Bibliographic metadata (title, authors, year, journal, DOI) for one paper.',
		parameters: { type: 'object', properties: { item_key: { type: 'string', description: 'the item key from a search result' } }, required: ['item_key'] },
	},
}
const READ_CONTEXT_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'read_context',
		description: 'Read the chunks immediately before and after a given excerpt for more context.',
		parameters: { type: 'object', properties: { item_key: { type: 'string' }, seq: { type: 'number', description: 'the seq of the excerpt to expand around' } }, required: ['item_key', 'seq'] },
	},
}
export const LOAD_SKILL_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'load_skill',
		description:
			'Load the full instructions for one of the installed skills listed at the end of this ' +
			'prompt. Call this before following a skill\'s procedure -- the catalog only gives you its ' +
			'name and a one-line description, not the actual steps.',
		parameters: { type: 'object', properties: { name: { type: 'string', description: 'the skill name from the catalog' } }, required: ['name'] },
	},
}

const BASE_READ_TOOLS: ToolDef[] = [SEARCH_LIBRARY_TOOL, GET_ITEM_INFO_TOOL, READ_CONTEXT_TOOL]

export const TOOL_REGISTRY: Record<string, ToolDef> = Object.fromEntries(
	[...BASE_READ_TOOLS, ...AGENT_ACTION_TOOLS].map((t) => [t.function.name, t]),
)

/** Resolve a mode's tool-name list to ToolDefs, appending load_skill only when
 *  the user has installed skills. Unknown names are dropped (guarded by test). */
export function buildTools(mode: AgentMode, hasSkills: boolean): ToolDef[] {
	const tools = mode.tools.map((n) => TOOL_REGISTRY[n]).filter((t): t is ToolDef => Boolean(t))
	if (hasSkills) tools.push(LOAD_SKILL_TOOL)
	return tools
}
