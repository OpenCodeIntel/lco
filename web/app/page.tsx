import Hero from '@/components/sections/hero'
import ContextRotDemo from '@/components/sections/context-rot-demo'
import Incentives from '@/components/sections/incentives'
import SpecFooter from '@/components/sections/spec-footer'
import Link from 'next/link'
import { Chrome } from 'lucide-react'
import { CWS_URL } from '@/lib/constants'

export default function HomePage() {
  return (
    <>
      <Hero />
      <ContextRotDemo />
      <Incentives />

      {/* Install CTA */}
      <section className="py-24 border-t border-saar-border">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <h2 className="font-serif text-4xl text-saar-text mb-4">
            Start noticing.
          </h2>
          <p className="text-saar-secondary mb-8">
            Free on Chrome. No account required. Works on claude.ai today.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href={CWS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg bg-saar-accent text-white font-medium hover:bg-saar-accent/90 transition-colors text-base"
            >
              <Chrome width={18} height={18} />
              Add to Chrome &middot; free
            </a>
            <Link
              href="/install"
              className="inline-flex items-center justify-center px-6 py-3.5 rounded-lg border border-saar-border text-saar-secondary hover:text-saar-text hover:border-saar-secondary transition-colors text-base"
            >
              MCP + Desktop waitlist
            </Link>
          </div>
        </div>
      </section>

      <SpecFooter />
    </>
  )
}
