const surfaces = [
  {
    n: '01',
    name: 'Chrome extension',
    status: 'shipped',
    detail: '280 commits / 1,808 tests / live on CWS',
    accent: true,
  },
  {
    n: '02',
    name: 'MCP server',
    status: 'Q4 2026',
    detail: 'Foundation-governed / registry.modelcontextprotocol.io',
    accent: false,
  },
  {
    n: '03',
    name: 'Tauri desktop',
    status: 'Q1 2027',
    detail: 'Menu-bar app / Claude Desktop + Cursor + Claude Code',
    accent: false,
  },
  {
    n: '04',
    name: 'Teams plan',
    status: '2027+',
    detail: '$8 / user / mo / token analytics across providers',
    accent: false,
  },
]

export default function SpecFooter() {
  return (
    <footer className="border-t border-saar-border py-16">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-saar-border rounded-xl overflow-hidden border border-saar-border">
          {surfaces.map((s) => (
            <div key={s.n} className="bg-saar-bg p-6">
              <div className="flex items-start gap-4">
                <span className="font-mono text-xs text-saar-muted flex-shrink-0 mt-0.5">
                  {s.n}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <span className="text-sm font-medium text-saar-text">{s.name}</span>
                    <span
                      className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                        s.accent
                          ? 'bg-saar-accent/15 text-saar-accent'
                          : 'bg-saar-hover text-saar-muted'
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <p className="font-mono text-xs text-saar-muted leading-relaxed">{s.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="font-mono text-xs text-saar-muted">
            Saar by{' '}
            <a
              href="https://github.com/DevanshuNEU"
              target="_blank"
              rel="noopener noreferrer"
              className="link-draw text-saar-secondary hover:text-saar-text"
            >
              Devanshu Chicholikar
            </a>
            . Solo. MS Software Engineering, Northeastern 2026.
          </div>
          <div className="font-mono text-xs text-saar-muted flex items-center gap-4">
            <a
              href="https://github.com/OpenCodeIntel/lco"
              target="_blank"
              rel="noopener noreferrer"
              className="link-draw hover:text-saar-text"
            >
              GitHub
            </a>
            <a
              href="/why"
              className="link-draw hover:text-saar-text"
            >
              Thesis
            </a>
            <a
              href="/changelog"
              className="link-draw hover:text-saar-text"
            >
              Changelog
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
