import { Component, type ErrorInfo, type ReactNode } from 'react'

// Without a boundary, one throwing component unmounts the entire React tree and
// the window goes white with nothing to act on -- no message, no way back, and
// no clue which component failed. This catches the fault, keeps the error where
// the user can read it, and offers a way out that does not need a restart.

interface Props {
	children: ReactNode
}

interface State {
	error: Error | null
	stack: string
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null, stack: '' }

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// Keep the component stack: the JS stack points into bundled code, while
		// this names the actual component that threw.
		this.setState({ stack: info.componentStack ?? '' })
		console.error('[ErrorBoundary]', error, info.componentStack)
	}

	render(): ReactNode {
		const { error, stack } = this.state
		if (!error) return this.props.children

		return (
			<div
				style={{
					height: '100%',
					overflowY: 'auto',
					padding: '40px 32px',
					background: 'var(--bg)',
					color: 'var(--foreground)',
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
				}}
			>
				<div style={{ width: '100%', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 14 }}>
					<h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-.01em' }}>
						Something in the interface crashed
					</h1>
					<p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--foreground-2)' }}>
						Your library is untouched — this is a display fault. Reloading usually clears it.
						Please include the details below when reporting it.
					</p>

					<pre style={preStyle}>{error.message || String(error)}</pre>
					{stack && <pre style={{ ...preStyle, maxHeight: 260 }}>{stack.trim()}</pre>}

					<div style={{ display: 'flex', gap: 10 }}>
						<button onClick={() => this.setState({ error: null, stack: '' })} style={btnStyle(false)}>
							Try again
						</button>
						<button onClick={() => window.location.reload()} style={btnStyle(true)}>
							Reload
						</button>
						<button
							onClick={() =>
								void navigator.clipboard.writeText(`${error.message}\n\n${error.stack ?? ''}\n\n${stack}`)
							}
							style={btnStyle(false)}
						>
							Copy details
						</button>
					</div>
				</div>
			</div>
		)
	}
}

const preStyle: React.CSSProperties = {
	margin: 0,
	padding: '10px 12px',
	borderRadius: 9,
	background: 'var(--muted-bg)',
	border: '1px solid var(--border)',
	color: 'var(--foreground-2)',
	fontSize: 11.5,
	lineHeight: 1.55,
	fontFamily: 'ui-monospace, monospace',
	whiteSpace: 'pre-wrap',
	wordBreak: 'break-word',
	overflowY: 'auto',
}

const btnStyle = (primary: boolean): React.CSSProperties => ({
	height: 32,
	padding: '0 14px',
	borderRadius: 9,
	border: primary ? 'none' : '1px solid var(--border)',
	background: primary ? 'var(--primary)' : 'var(--surface)',
	color: primary ? '#fff' : 'var(--foreground-2)',
	fontSize: 12.5,
	fontWeight: 600,
})
