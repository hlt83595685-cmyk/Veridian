import { HOST_HTML, HOST_SCRIPT } from '../../shared/pluginRuntimeSource'

// The sandbox page's policy. `connect-src 'none'` is what stops the Worker (a blob Worker inherits
// its creator's CSP) from making any request of its own; every network call goes through the host.
export const PLUGIN_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self'; worker-src blob:; connect-src 'none'"

export function pluginAssetResponse(pathname: string): Response {
	const base = { 'Content-Security-Policy': PLUGIN_CSP, 'Cache-Control': 'no-store' }
	if (pathname === '/host.html') {
		return new Response(HOST_HTML, { headers: { ...base, 'Content-Type': 'text/html; charset=utf-8' } })
	}
	if (pathname === '/host.js') {
		return new Response(HOST_SCRIPT, { headers: { ...base, 'Content-Type': 'text/javascript; charset=utf-8' } })
	}
	return new Response('Not found', { status: 404 })
}
