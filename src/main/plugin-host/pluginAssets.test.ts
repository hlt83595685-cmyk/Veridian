import { describe, it, expect } from 'vitest'
import { pluginAssetResponse, PLUGIN_CSP } from './pluginAssets'

describe('pluginAssetResponse', () => {
	it('serves host.html with the network-blocking CSP', async () => {
		const res = pluginAssetResponse('/host.html')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
		expect(res.headers.get('content-type')).toContain('text/html')
		expect(await res.text()).toContain('src="host.js"')
	})

	it('serves host.js with the same CSP', async () => {
		const res = pluginAssetResponse('/host.js')
		expect(res.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
		expect(res.headers.get('content-type')).toContain('text/javascript')
		expect(await res.text()).toContain("t: 'ready'")
	})

	it('blocks every direct network path in the CSP', () => {
		expect(PLUGIN_CSP).toContain("connect-src 'none'")
		expect(PLUGIN_CSP).toContain("default-src 'none'")
		expect(PLUGIN_CSP).toContain('sandbox allow-scripts')
	})

	it('404s everything else, including plugin source', () => {
		expect(pluginAssetResponse('/index.js').status).toBe(404)
		expect(pluginAssetResponse('/').status).toBe(404)
	})
})
