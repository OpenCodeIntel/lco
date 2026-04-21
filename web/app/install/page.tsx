import type { Metadata } from 'next'
import { Chrome } from 'lucide-react'
import WaitlistForm from './waitlist-form'
import { CWS_URL } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'Install Saar',
  description: 'Add Saar to Chrome free. Join the MCP and Desktop waitlist.',
}

export default function InstallPage() {
  return (
    <div className="pt-32 pb-24 px-6">
      <div className="max-w-2xl mx-auto">
        <p className="font-mono text-xs text-saar-muted uppercase tracking-widest mb-8">
          Get started
        </p>

        {/* Chrome section */}
        <section className="mb-16">
          <h1 className="font-serif text-5xl text-saar-text leading-tight mb-4">
            Chrome extension
          </h1>
          <p className="text-saar-secondary text-lg leading-relaxed mb-8">
            Works on claude.ai. Local BPE tokenizer, no account, no data leaving
            your browser. Free forever.
          </p>

          <a
            href={CWS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 px-6 py-4 rounded-xl bg-saar-accent text-white font-medium text-lg hover:bg-saar-accent/90 transition-colors"
          >
            <Chrome width={22} height={22} />
            Add to Chrome &middot; free
          </a>

          <div className="mt-6 grid grid-cols-3 gap-4 max-w-sm">
            {[
              ['136', 'commits'],
              ['1,452', 'tests'],
              ['39', 'merged PRs'],
            ].map(([value, label]) => (
              <div key={label} className="rounded-lg border border-saar-border bg-saar-card p-4 text-center">
                <div className="font-mono text-lg font-bold text-saar-text">{value}</div>
                <div className="text-xs text-saar-muted mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="h-px bg-saar-border mb-16" />

        {/* MCP + Desktop waitlist */}
        <section>
          <h2 className="font-serif text-4xl text-saar-text leading-tight mb-4">
            MCP server + Desktop app
          </h2>
          <p className="text-saar-secondary text-lg leading-relaxed mb-4">
            The MCP server ships to the Anthropic registry in Q4 2026. The Tauri
            menu-bar app ships Q1 2027. Both work across Claude Desktop, Cursor,
            and Claude Code simultaneously.
          </p>
          <p className="text-saar-muted text-sm mb-8">
            Leave your email and you&apos;ll get one message when they ship. No newsletter.
          </p>

          <WaitlistForm />
        </section>
      </div>
    </div>
  )
}
