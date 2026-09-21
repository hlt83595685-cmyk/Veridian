// Translates the selected text with an OpenAI-compatible chat API.
// Runs in the plugin sandbox: `veridian` is injected, and all network access goes through veridian.fetch.

const systemPrompt = (lang) =>
	'You are a translation engine. Translate the user\'s text into ' + lang + '. ' +
	'Keep Markdown, LaTeX formulas, code and numbers exactly as they are. ' +
	'Output only the translation, with no explanations.'

veridian.onSelectionAction('translate', async ({ text, config, signal, output }) => {
	const base = String(config.baseURL || '').replace(/\/+$/, '')
	const res = await veridian.fetch(base + '/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
		body: JSON.stringify({
			model: config.model,
			stream: true,
			messages: [
				{ role: 'system', content: systemPrompt(config.targetLang || '中文') },
				{ role: 'user', content: text },
			],
		}),
		signal,
	})
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 300)
		throw new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''))
	}
	if (!res.body) throw new Error('empty response')

	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		buf += decoder.decode(value, { stream: true })
		let nl
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl).trim()
			buf = buf.slice(nl + 1)
			if (!line.startsWith('data:')) continue
			const data = line.slice(5).trim()
			if (data === '[DONE]') return
			let piece = ''
			try { piece = JSON.parse(data).choices[0].delta.content || '' } catch { continue }
			if (piece) output(piece)
		}
	}
})
