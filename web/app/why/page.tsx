import type { Metadata } from 'next'
import Link from 'next/link'
import { Chrome } from 'lucide-react'
import { CWS_URL } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'Why Saar',
  description:
    'Platforms selling compute have no incentive to help you use less of it. Saar does.',
}

export default function WhyPage() {
  return (
    <article className="pt-32 pb-24 px-6">
      <div className="max-w-2xl mx-auto">
        <p className="font-mono text-xs text-saar-muted uppercase tracking-widest mb-8">
          The thesis
        </p>

        <h1 className="font-serif text-5xl text-saar-text leading-[1.08] mb-12">
          Platforms selling compute have no incentive to help you use less of it.
        </h1>

        <div className="space-y-6 text-saar-secondary leading-relaxed text-lg">
          <p>
            In Q1 2026, Anthropic shipped 1M context windows at standard pricing.
            Dev Twitter exhaled. The context window problem was supposed to be solved.
          </p>

          <p>
            It wasn&apos;t. Chroma&apos;s 2025 attention-curve research shows that every
            frontier LLM decays past roughly 50% utilization with 20 or more turns.
            That number did not change when the window grew. What changed: the decay
            moved from visible to invisible. Your conversations are now large enough
            that you stop noticing the rot until it has already cost you.
          </p>

          <p>
            Saar started as a token tracker. That was sherlocked the day 1M context
            shipped. Five Chrome extensions now compete on raw token counting. None of
            them tell you to stop.
          </p>

          <h2 className="font-serif text-3xl text-saar-text pt-4">
            The misaligned incentives problem
          </h2>

          <p>
            Anthropic, OpenAI, and Google are compute businesses. They win when you
            send more tokens, start more conversations, and pay more per month. They
            have no product reason to build a tool that tells you to stop. That
            would be like a bar installing a breathalyzer at the door.
          </p>

          <p>
            Saar is not a compute business. We win when your AI sessions are sharp,
            short, and productive. That misalignment is the moat. Providers can ship
            all the memory features and summarization they want. They still can&apos;t
            tell you with a straight face to start a new chat.
          </p>

          <h2 className="font-serif text-3xl text-saar-text pt-4">
            What we built
          </h2>

          <p>
            A Chrome extension that intercepts your Claude conversations locally,
            counts tokens with a BPE tokenizer, and coaches you in real time. No
            server, no account, no data leaving your browser. When your context
            passes 70%, Saar says so. At 90%, it tells you the conversation is spent.
          </p>

          <p>
            That&apos;s Wave 1. Wave 2 is an MCP server on the Anthropic registry and a
            Tauri menu-bar app that watches Claude Desktop, Cursor, and Claude Code
            simultaneously. The distribution channel for Wave 2 is governed by the
            Agentic AI Foundation, a Linux Foundation project co-founded by Anthropic,
            OpenAI, and Block. Even if Anthropic wanted to sherlock us, the registry
            they&apos;d have to kick us off is one they share with their competitors.
          </p>

          <h2 className="font-serif text-3xl text-saar-text pt-4">
            Who this is for
          </h2>

          <p>
            Solo builders and indie hackers who use AI daily, hit context limits
            daily, and are tired of figuring out why a 40-turn conversation is giving
            worse answers than a 5-turn one. People who notice things.
          </p>

          <p>
            If you think 1M context windows mean you never need to start a new chat,
            Saar is not for you. That&apos;s fine. We&apos;d rather have 1,000 users who
            care than 100,000 who installed us and forgot.
          </p>
        </div>

        <div className="mt-16 pt-8 border-t border-saar-border flex flex-col sm:flex-row gap-3">
          <a
            href={CWS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-saar-accent text-white font-medium hover:bg-saar-accent/90 transition-colors"
          >
            <Chrome width={16} height={16} />
            Install free on Chrome
          </a>
          <Link
            href="/"
            className="inline-flex items-center justify-center px-5 py-3 rounded-lg border border-saar-border text-saar-secondary hover:text-saar-text hover:border-saar-secondary transition-colors"
          >
            Back to home
          </Link>
        </div>
      </div>
    </article>
  )
}
