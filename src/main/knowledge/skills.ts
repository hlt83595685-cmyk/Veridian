// Marketplace-installed "skills" -- reusable instruction blocks the chat
// agent can load on demand. Same shape as Anthropic's own Agent Skills spec
// (SKILL.md: YAML frontmatter + Markdown body). Read-only text only, no code
// execution -- installing a skill can never run anything, only add text to
// the model's context via agent.ts's load_skill tool.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'

export interface SkillInfo {
	name: string
	description: string
}

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 30

function skillsRoot(): string {
	const dir = join(app.getPath('userData'), 'skills')
	mkdirSync(dir, { recursive: true })
	return dir
}

// Validated here, not just in writeSkill() -- every caller (uninstall,
// getSkillBody via the load_skill tool/skill refs) must be protected against
// a name like "../../../Documents" resolving outside the skills root.
function skillDir(name: string): string {
	if (!NAME_RE.test(name)) throw new Error(`invalid skill name "${name}"`)
	return join(skillsRoot(), name)
}

/** Minimal frontmatter parser: `---\nkey: value\n...\n---\nbody`. Only flat,
 *  single-line string values are supported -- SKILL.md's spec never needs more. */
function parseFrontmatter(raw: string): { name: string; description: string; body: string } | null {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
	if (!m) return null
	const fields: Record<string, string> = {}
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/)
		if (!kv) continue
		fields[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1')
	}
	if (!fields.name || !fields.description) return null
	return { name: fields.name, description: fields.description, body: m[2] }
}

export function listInstalledSkills(): SkillInfo[] {
	const root = skillsRoot()
	const out: SkillInfo[] = []
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		const mdPath = join(root, entry.name, 'SKILL.md')
		if (!existsSync(mdPath)) continue
		const parsed = parseFrontmatter(readFileSync(mdPath, 'utf-8'))
		if (parsed) out.push({ name: parsed.name, description: parsed.description })
	}
	return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function getSkillBody(name: string): string | null {
	const mdPath = join(skillDir(name), 'SKILL.md')
	if (!existsSync(mdPath)) return null
	const parsed = parseFrontmatter(readFileSync(mdPath, 'utf-8'))
	return parsed?.body.trim() ?? null
}

export function uninstallSkill(name: string): void {
	const dir = skillDir(name)
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** Writes a validated skill (frontmatter + sibling files) into the skills
 *  root, replacing any existing install of the same name. */
function writeSkill(parsed: { name: string; description: string }, files: Map<string, Buffer>): void {
	if (!NAME_RE.test(parsed.name)) {
		throw new Error(`invalid skill name "${parsed.name}" (lowercase letters, numbers, hyphens only)`)
	}
	const dir = skillDir(parsed.name)
	rmSync(dir, { recursive: true, force: true })
	mkdirSync(dir, { recursive: true })
	for (const [relPath, data] of files) {
		const dest = join(dir, relPath)
		mkdirSync(dirname(dest), { recursive: true })
		writeFileSync(dest, data)
	}
}

export function installSkillFromZip(zipBuf: Buffer): SkillInfo {
	const zip = new AdmZip(zipBuf)
	const entries = zip.getEntries().filter((e) => !e.isDirectory)
	if (entries.length > MAX_FILES) throw new Error(`too many files in zip (max ${MAX_FILES})`)

	// SKILL.md may sit at the zip root or one level down (folder-wrapped zips
	// are the common case when downloading a GitHub folder as a zip).
	const skillEntry = entries.find((e) => /(^|\/)SKILL\.md$/i.test(e.entryName))
	if (!skillEntry) throw new Error('SKILL.md not found in zip')
	const base = skillEntry.entryName.slice(0, skillEntry.entryName.length - 'SKILL.md'.length)

	const parsed = parseFrontmatter(skillEntry.getData().toString('utf-8'))
	if (!parsed) throw new Error('SKILL.md missing name/description frontmatter')

	const files = new Map<string, Buffer>()
	for (const e of entries) {
		if (!e.entryName.startsWith(base)) continue   // ignore siblings outside the skill folder
		const rel = e.entryName.slice(base.length)
		if (!rel || rel.includes('..')) continue
		const data = e.getData()
		if (data.length > MAX_FILE_BYTES) throw new Error(`${rel} exceeds 2MB limit`)
		files.set(rel, data)
	}
	writeSkill(parsed, files)
	return { name: parsed.name, description: parsed.description }
}

const GH_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'Veridian' }

interface GhContentEntry {
	name: string
	type: 'file' | 'dir'
	download_url: string | null
}

function parseGithubFolderUrl(url: string): { owner: string; repo: string; ref: string | null; path: string } {
	const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/)
	if (!m) throw new Error('unrecognized GitHub URL (expected https://github.com/<owner>/<repo>[/tree/<branch>/<path>])')
	return { owner: m[1], repo: m[2].replace(/\.git$/, ''), ref: m[3] ?? null, path: (m[4] ?? '').replace(/\/+$/, '') }
}

/** Installs a skill whose SKILL.md lives directly in a GitHub folder (repo
 *  root or a /tree/<branch>/<path> subfolder). Only direct files in that
 *  folder are pulled -- nested subdirectories are out of scope for v1;
 *  real-world skills are flat (SKILL.md + a couple of reference files). */
export async function installSkillFromGithubUrl(url: string): Promise<SkillInfo> {
	const { owner, repo, ref, path } = parseGithubFolderUrl(url)
	let branch = ref
	if (!branch) {
		const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: GH_HEADERS })
		if (!r.ok) throw new Error(`repo lookup failed: HTTP ${r.status}`)
		branch = ((await r.json()) as { default_branch: string }).default_branch
	}

	const listUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
	const listRes = await fetch(listUrl, { headers: GH_HEADERS })
	if (!listRes.ok) throw new Error(`GitHub lookup failed: HTTP ${listRes.status}`)
	const entries = (await listRes.json()) as GhContentEntry[] | GhContentEntry
	if (!Array.isArray(entries)) throw new Error('that URL points at a single file, not a folder')
	if (entries.length > MAX_FILES) throw new Error(`too many files in that folder (max ${MAX_FILES})`)

	const skillEntry = entries.find((e) => e.type === 'file' && e.name.toLowerCase() === 'skill.md')
	if (!skillEntry?.download_url) throw new Error('SKILL.md not found at that URL')

	const files = new Map<string, Buffer>()
	let parsed: { name: string; description: string; body: string } | null = null
	for (const e of entries) {
		if (e.type !== 'file' || !e.download_url) continue
		const r = await fetch(e.download_url)
		if (!r.ok) throw new Error(`download failed for ${e.name}: HTTP ${r.status}`)
		const buf = Buffer.from(await r.arrayBuffer())
		if (buf.length > MAX_FILE_BYTES) throw new Error(`${e.name} exceeds 2MB limit`)
		if (e.name.toLowerCase() === 'skill.md') parsed = parseFrontmatter(buf.toString('utf-8'))
		files.set(e.name, buf)
	}
	if (!parsed) throw new Error('SKILL.md missing name/description frontmatter')
	writeSkill(parsed, files)
	return { name: parsed.name, description: parsed.description }
}
