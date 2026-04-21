import Link from 'next/link'
import { Chrome } from 'lucide-react'
import LiveHeroCard from '@/components/sections/live-hero-card'
import { CWS_URL } from '@/lib/constants'

export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center pt-16">
      <div className="max-w-6xl mx-auto px-6 w-full">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center py-24">
          {/* Left: headline + CTAs */}
          <div>
            <p className="text-saar-muted text-xs font-mono tracking-widest uppercase mb-8">
              For Claude.ai
            </p>

            <h1 className="font-serif text-5xl lg:text-6xl xl:text-7xl leading-[1.08] text-saar-text mb-8">
              An AI usage coach for people who{' '}
              <em className="not-italic text-saar-accent">actually</em> notice.
            </h1>

            <p className="text-saar-secondary text-lg leading-relaxed mb-10 max-w-md">
              Saar sits beside your Claude conversations and tells you when to
              start fresh. Free on Chrome. MCP and Desktop coming in 2026.
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <a
                href={CWS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-saar-accent text-white font-medium hover:bg-saar-accent/90 transition-colors"
              >
                <Chrome width={18} height={18} />
                Add to Chrome &middot; free
              </a>
              <Link
                href="/why"
                className="inline-flex items-center justify-center px-5 py-3 rounded-lg border border-saar-border text-saar-secondary hover:text-saar-text hover:border-saar-secondary transition-colors"
              >
                Why Saar
              </Link>
            </div>

            <p className="mt-6 text-saar-muted text-xs font-mono">
              136 commits{' · '}1,452 tests{' · '}live on Chrome Web Store
            </p>
          </div>

          {/* Right: live hero card */}
          <div className="flex justify-center lg:justify-end">
            <div className="relative">
              {/* Ambient glow behind the card */}
              <div
                className="absolute inset-0 rounded-2xl blur-3xl opacity-20"
                style={{ background: 'radial-gradient(circle, #c15f3c, transparent 70%)' }}
              />
              <LiveHeroCard />
            </div>
          </div>
        </div>
      </div>

      {/* Scroll hint */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1">
        <span className="text-saar-muted text-xs">scroll to see it degrade</span>
        <div className="w-px h-8 bg-gradient-to-b from-saar-muted to-transparent" />
      </div>
    </section>
  )
}
