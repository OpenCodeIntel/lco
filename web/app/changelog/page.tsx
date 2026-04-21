import type { Metadata } from 'next'
import { getChangelogEntries } from '@/lib/changelog'

export const metadata: Metadata = {
  title: 'Changelog · Saar',
  description: 'What shipped and when.',
}

const tagColors: Record<string, string> = {
  'health-score': 'bg-saar-accent/15 text-saar-accent',
  feature: 'bg-saar-green/15 text-saar-green',
  fix: 'bg-saar-yellow/15 text-saar-yellow',
  update: 'bg-saar-hover text-saar-muted',
}

function tagClass(tag: string): string {
  return tagColors[tag] ?? tagColors.update
}

export default function ChangelogPage() {
  const entries = getChangelogEntries()

  return (
    <div className="pt-32 pb-24 px-6">
      <div className="max-w-2xl mx-auto">
        <p className="font-mono text-xs text-saar-muted uppercase tracking-widest mb-4">
          Build log
        </p>
        <h1 className="font-serif text-5xl text-saar-text mb-12">Changelog</h1>

        {entries.length === 0 ? (
          <p className="text-saar-muted">No entries yet.</p>
        ) : (
          <div className="space-y-8">
            {entries.map((entry) => (
              <article
                key={entry.slug}
                className="rounded-xl border border-saar-border bg-saar-card p-6"
              >
                <div className="flex items-center gap-3 mb-3 flex-wrap">
                  <time className="font-mono text-xs text-saar-muted">{entry.date}</time>
                  <span
                    className={`font-mono text-[10px] px-2 py-0.5 rounded ${tagClass(entry.tag)}`}
                  >
                    {entry.tag}
                  </span>
                </div>
                <h2 className="text-base font-semibold text-saar-text mb-3">
                  {entry.title}
                </h2>
                <p className="text-sm text-saar-secondary leading-relaxed whitespace-pre-line">
                  {entry.content}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
