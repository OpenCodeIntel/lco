import Link from 'next/link'
import { Chrome } from 'lucide-react'
import { CWS_URL } from '@/lib/constants'

export default function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-6 py-4 border-b border-saar-border bg-saar-bg/90 backdrop-blur-sm">
      <Link href="/" className="flex items-center gap-2">
        <span className="font-mono text-xs tracking-[0.2em] uppercase text-saar-accent font-semibold">
          S A A R
        </span>
      </Link>

      <div className="flex items-center gap-6">
        <Link
          href="/why"
          className="link-draw text-sm text-saar-secondary hover:text-saar-text transition-colors"
        >
          Why
        </Link>
        <Link
          href="/changelog"
          className="link-draw text-sm text-saar-secondary hover:text-saar-text transition-colors"
        >
          Changelog
        </Link>
        <a
          href={CWS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-saar-accent text-white text-sm font-medium hover:bg-saar-accent/90 transition-colors"
        >
          <Chrome width={14} height={14} />
          Install free
        </a>
      </div>
    </nav>
  )
}
