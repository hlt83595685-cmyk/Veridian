// The chat assistant runs in one "mode" per turn. A mode is a code-defined
// bundle of {keywords for auto-detection, the exact tools exposed (gating), a
// procedure appended to the slim base prompt}. Gating is what makes misbehaviour
// structurally impossible: e.g. the 'qa' mode never exposes write tools or
// list_items, so the model cannot misuse them to answer a question.
export type ModeId = 'qa' | 'classify' | 'tag' | 'review' | 'compare' | 'contradict' | 'notes'

export interface AgentMode {
	id: ModeId
	label: string          // i18n key for the preset button
	keywords: RegExp | null // auto-detection; null = never auto-matched (qa is the fallback)
	tools: string[]        // tool names exposed this mode (resolved via toolRegistry)
	procedure: string      // appended after the slim base prompt
	button: boolean        // show a preset button in the composer
}

const ANALYZE_TOOLS = ['list_items', 'read_item', 'search_library', 'get_item_info', 'create_note']

export const MODES: AgentMode[] = [
	{
		id: 'classify', label: 'knowledge.mode.classify', button: true,
		keywords: /分类|归档|归类|整理到|整理进|classif|categor|organi[sz]e/i,
		tools: ['list_items', 'read_item', 'search_library', 'list_collections', 'add_to_collection'],
		procedure: `MODE: Classifying papers into collections.
- Call list_items to see the papers in the current scope. Judge each paper's topic from its title, or use read_item / search_library when the title is not enough.
- Decide a small set of sensible collections; call list_collections to reuse existing ones. File each paper with add_to_collection (it creates the collection if missing). You may issue many add_to_collection calls in one turn.
- If there are many papers, do a bounded batch, then tell the user how many you filed and how many remain.
- End with a one-line summary of what you filed where.`,
	},
	{
		id: 'tag', label: 'knowledge.mode.tag', button: true,
		keywords: /打标签|加标签|贴标签|标注为|tag (these|them|all|it)/i,
		tools: ['list_items', 'read_item', 'list_tags', 'add_tags'],
		procedure: `MODE: Tagging papers.
- Call list_items for the papers in scope. For each, extract a few topical keyword tags (from the title, or read_item). Call list_tags first to reuse consistent tag names. Apply with add_tags (existing tags are kept).
- Batch large sets; report how many you tagged.
- End with a one-line summary.`,
	},
	{
		id: 'review', label: 'knowledge.mode.review', button: true,
		keywords: /综述|概述|文献综述|review|overview/i,
		tools: ANALYZE_TOOLS,
		procedure: `MODE: Literature review of multiple papers.
- Read the papers in scope (list_items to enumerate; read_item / search_library for content). Synthesise a structured review: themes, methods, key findings (with figures/numbers), agreements and gaps. Cite specifics with [^item_key:seq] when they come from search_library.
- If the user asks, save the review with create_note; otherwise present it and offer to save.`,
	},
	{
		id: 'compare', label: 'knowledge.mode.compare', button: true,
		keywords: /对比|比较|异同|compare|comparison/i,
		tools: ANALYZE_TOOLS,
		procedure: `MODE: Comparing papers.
- Read the papers in scope. Produce a comparison table across the salient dimensions (problem, method, data, key result, limitations). Cite specifics. Offer to save as a note with create_note if useful.`,
	},
	{
		id: 'contradict', label: 'knowledge.mode.contradict', button: true,
		keywords: /矛盾|冲突|不一致|contradic|conflict|disagree/i,
		tools: ANALYZE_TOOLS,
		procedure: `MODE: Finding contradictions.
- Read the papers in scope and identify claims that conflict or disagree between papers. For each contradiction, state both sides with their sources. Be precise; do not invent conflicts. Offer to save the findings as a note.`,
	},
	{
		id: 'notes', label: 'knowledge.mode.notes', button: true,
		keywords: /建链|建立链接|关联起来|生成笔记|做笔记|link (these|them)/i,
		tools: ['search_library', 'read_item', 'list_items', 'create_note', 'update_note', 'list_notes', 'link_items', 'read_notes'],
		procedure: `MODE: Notes & links.
- To summarise a paper, write a structured note with create_note (one-line summary, problem, method, key findings, contributions/limits, key concepts).
- To connect papers, find related items with search_library / list_items and create typed links with link_items (rel_type ∈ extends | contradicts | related | cites | same_method). Use read_notes to see existing notes.
- You may create standalone concept notes (create_note without item_key, title = the concept) and update existing notes (update_note by note_id — read it first with list_notes/read_notes before overwriting). Cross-link with [[Title]] in the body.
- End with a one-line summary of the notes/links you created.`,
	},
	{
		id: 'qa', label: 'knowledge.mode.qa', button: false,
		keywords: null,
		tools: ['search_library', 'read_item', 'read_context', 'get_item_info'],
		procedure: `MODE: Answering questions.
- To get content, use search_library (relevant passages across the library; it honours the selected scope and gives [^item_key:seq] citations) or, for a small selected collection you want to analyse, read_item (one paper's full text). Use read_context to expand around a hit and get_item_info for metadata.
- If nothing relevant is found, say so plainly. You cannot modify the library in this mode.`,
	},
]

export function getMode(id: string): AgentMode {
	return MODES.find((m) => m.id === id) ?? MODES.find((m) => m.id === 'qa')!
}

/** Pick the mode: an explicit (button-chosen) modeId wins; else the first mode
 *  whose keywords match the message; else 'qa' (read-only, safe fallback). */
export function routeMode(message: string, explicitModeId?: string | null): AgentMode {
	if (explicitModeId) {
		const m = MODES.find((x) => x.id === explicitModeId)
		if (m) return m
	}
	for (const m of MODES) {
		if (m.keywords && m.keywords.test(message)) return m
	}
	return getMode('qa')
}
