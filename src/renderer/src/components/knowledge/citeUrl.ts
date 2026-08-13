import { defaultUrlTransform } from 'react-markdown'

// react-markdown v10 sanitizes every URL through defaultUrlTransform, which
// blanks any scheme outside http(s)/mailto/xmpp -- including our private
// veridian-cite:// citation links. A blanked href renders as <a href=""> and a
// click navigates to the app root (e.g. http://localhost:5174/). Whitelist our
// own scheme and defer everything else to the default sanitizer, so dangerous
// schemes (javascript:, etc.) are still stripped.
export function citeUrlTransform(url: string): string {
	return url.startsWith('veridian-cite://') ? url : defaultUrlTransform(url)
}
