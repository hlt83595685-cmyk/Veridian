import { useEffect, useRef, useState } from 'react'

/**
 * True once the returned ref's element has entered the viewport (with a
 * lookahead margin), and STAYS true afterward -- this gates one-time work
 * (fetch + render) per row, not visibility tracking. Used so off-screen list
 * rows do zero IPC/network/decode work until the user scrolls near them.
 */
export function useInView<T extends HTMLElement>(rootMargin = '200px'): {
  ref: React.RefObject<T>
  inView: boolean
} {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (inView) return   // already triggered -- no need to keep observing
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setInView(true)
      },
      { rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [inView, rootMargin])

  return { ref, inView }
}
