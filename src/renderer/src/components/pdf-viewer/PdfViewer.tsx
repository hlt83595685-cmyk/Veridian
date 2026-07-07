interface PdfViewerProps {
  filePath: string
}

export function PdfViewer({ filePath }: PdfViewerProps): JSX.Element {
  // Use custom veridian-file:// protocol — file:// is blocked by Electron CSP
  // Convert backslashes and encode path components (but not the drive colon)
  const encoded = filePath
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const src = `veridian-file://${encoded}`

  return (
    <iframe
      src={src}
      className="w-full h-full border-0"
      title="PDF Viewer"
      style={{ display: 'block' }}
    />
  )
}
