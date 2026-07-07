// Stub for Node.js 'fs' module — annotpdf imports fs only for loadFile/save,
// which we never call from the renderer. This prevents Vite browser warnings.
export const readFileSync = (): never => { throw new Error('fs.readFileSync not available in renderer') }
export const writeFile = (): never => { throw new Error('fs.writeFile not available in renderer') }
export default { readFileSync, writeFile }
