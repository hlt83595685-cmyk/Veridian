import { basename, dirname, normalize } from 'path'

// The user picks the folder that IS (or contains) their `papers/` library.
// If they pick the `papers` folder itself, the content root is its parent
// (importAll/exportItems operate on the root that CONTAINS papers/ +
// collections.json). Any other folder is treated as the root directly.
// Case-insensitive: Windows folder names are.
export function normalizeContentRoot(pickedPath: string): string {
  const p = normalize(pickedPath.trim())
  return basename(p).toLowerCase() === 'papers' ? dirname(p) : p
}
