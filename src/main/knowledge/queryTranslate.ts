import { getChatConfig, chatStream } from './providers'

const TIMEOUT_MS = 12_000
const TRANSLATE_SYSTEM =
	'Translate the user\'s search query to English. Output ONLY the translation, ' +
	'no quotes, no explanation. If it is already English, output it unchanged.'

/** True if the string contains a CJK ideograph (Chinese). Cheap gate so only
 *  Chinese queries pay for a translation. */
export function hasCJK(s: string): boolean {
	return /[㐀-鿿]/.test(s)
}

/** Translate a Chinese search query to English for the retrieval second pass.
 *  Returns null (caller falls back to the original query alone) when the query
 *  is not Chinese, no chat model is configured, or the call fails/times out. */
export async function translateForSearch(query: string): Promise<string | null> {
	if (!hasCJK(query)) return null
	const cfg = getChatConfig()
	if (!cfg) return null
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
	try {
		const res = await chatStream(cfg, [
			{ role: 'system', content: TRANSLATE_SYSTEM },
			{ role: 'user', content: query },
		], [], () => {}, ctrl.signal)
		const out = res.content.trim()
		return out && out !== query ? out : null
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}
