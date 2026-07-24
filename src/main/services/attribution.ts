// Zero-import mutable holder for "who is adding items right now" (a GitHub
// login, or null outside a collaborative workspace). Deliberately importless
// so the low-level db/items layer can read it WITHOUT creating a service-layer
// import cycle. Set by WorkspaceContextService on workspace activation.
let current: string | null = null

export function getAttribution(): string | null {
  return current
}

export function setAttribution(login: string | null): void {
  current = login
}
