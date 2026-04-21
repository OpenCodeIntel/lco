import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy · Saar',
  description: 'Saar processes all data locally inside your browser. No text, tokens, costs, or usage data are ever transmitted to any server.',
}

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-serif text-4xl text-saar-text mb-2">Privacy Policy</h1>
      <p className="text-saar-muted text-sm mb-12">Saar: Last updated April 2026</p>

      <section className="mb-8">
        <h2 className="text-saar-text font-medium text-lg mb-3">Summary</h2>
        <p className="text-saar-secondary leading-relaxed">
          Saar processes all data locally inside your browser. No text, tokens, costs, or usage
          data are ever transmitted to any server operated by this extension.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-saar-text font-medium text-lg mb-3">What data is processed</h2>
        <p className="text-saar-secondary leading-relaxed mb-3">
          Saar intercepts the SSE response stream from{' '}
          <code className="text-saar-accent font-mono text-sm">claude.ai</code> to read token
          counts and model information returned by Anthropic&apos;s servers. This data is:
        </p>
        <ul className="list-disc list-inside space-y-2 text-saar-secondary leading-relaxed">
          <li>Counted locally using a BPE tokenizer bundled inside the extension.</li>
          <li>
            Stored temporarily in{' '}
            <code className="text-saar-accent font-mono text-sm">chrome.storage.session</code>,
            scoped to your current browser session. It is cleared when the browser closes.
          </li>
          <li>Never sent to any external server, analytics service, or third party.</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-saar-text font-medium text-lg mb-3">What data is not collected</h2>
        <ul className="list-disc list-inside space-y-2 text-saar-secondary leading-relaxed">
          <li>The content of your messages or Claude&apos;s responses is never read or stored.</li>
          <li>No account information, cookies, or authentication tokens are accessed.</li>
          <li>No personally identifiable information is collected.</li>
          <li>No usage analytics or telemetry are sent anywhere.</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-saar-text font-medium text-lg mb-3">Permissions used</h2>
        <ul className="list-disc list-inside space-y-2 text-saar-secondary leading-relaxed">
          <li>
            <strong className="text-saar-text">storage</strong> — stores per-session token counts
            locally in your browser.
          </li>
          <li>
            <strong className="text-saar-text">tabs</strong> — identifies which tab a token count
            belongs to so session totals stay per-tab.
          </li>
          <li>
            <strong className="text-saar-text">scripting</strong> — injects the stream interceptor
            into claude.ai at page load.
          </li>
          <li>
            <strong className="text-saar-text">alarms</strong> — schedules periodic cleanup of
            stale session data for closed tabs.
          </li>
          <li>
            <strong className="text-saar-text">unlimitedStorage</strong> — allows the extension to
            store session data without Chrome&apos;s default quota limits.
          </li>
          <li>
            <strong className="text-saar-text">sidePanel</strong> — enables the side panel UI
            showing session history and cost totals.
          </li>
          <li>
            <strong className="text-saar-text">
              optional host permission: https://claude.ai/*
            </strong>{' '}
            — requested at runtime when you first enable the extension. Required to observe the SSE
            stream on that domain.
          </li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-saar-text font-medium text-lg mb-3">Third-party services</h2>
        <p className="text-saar-secondary leading-relaxed">
          Saar does not integrate with any third-party analytics, advertising, or data collection
          service. The BPE tokenizer vocabulary (
          <code className="text-saar-accent font-mono text-sm">claude.json</code>) is bundled
          inside the extension and does not make network requests.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-saar-text font-medium text-lg mb-3">Open source</h2>
        <p className="text-saar-secondary leading-relaxed">
          Saar is fully open source. You can inspect every line of code at{' '}
          <a
            href="https://github.com/OpenCodeIntel/lco"
            target="_blank"
            rel="noopener noreferrer"
            className="text-saar-accent hover:underline"
          >
            github.com/OpenCodeIntel/lco
          </a>
          .
        </p>
      </section>

      <section>
        <h2 className="text-saar-text font-medium text-lg mb-3">Contact</h2>
        <p className="text-saar-secondary leading-relaxed">
          Questions about this policy:{' '}
          <a href="mailto:devanshurajesh@gmail.com" className="text-saar-accent hover:underline">
            devanshurajesh@gmail.com
          </a>
        </p>
      </section>
    </div>
  )
}
