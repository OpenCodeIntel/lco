'use client'

import { useState, type FormEvent } from 'react'

type State = 'idle' | 'loading' | 'done' | 'error'

export default function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!email.trim()) return
    setState('loading')

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })

      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? 'Something went wrong')
      }

      setState('done')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setState('error')
    }
  }

  if (state === 'done') {
    return (
      <div className="rounded-xl border border-saar-accent/30 bg-saar-card p-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full bg-saar-green" />
          <span className="text-sm font-medium text-saar-green">You&apos;re on the list</span>
        </div>
        <p className="text-saar-secondary text-sm">
          We&apos;ll send one email when MCP and Desktop ship. Nothing else.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-md">
      <form onSubmit={submit} className="flex flex-col sm:flex-row gap-3">
        <input
          type="email"
          required
          maxLength={254}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={state === 'loading'}
          className="flex-1 px-4 py-3 rounded-lg border border-saar-border bg-saar-card text-saar-text placeholder:text-saar-muted text-sm outline-none focus:border-saar-accent transition-colors disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={state === 'loading' || !email.trim()}
          className="px-5 py-3 rounded-lg bg-saar-card border border-saar-border text-saar-text text-sm font-medium hover:border-saar-accent hover:text-saar-accent transition-colors disabled:opacity-50 whitespace-nowrap"
        >
          {state === 'loading' ? 'Joining...' : 'Notify me'}
        </button>
      </form>
      {state === 'error' && (
        <p className="text-saar-red text-xs mt-2">{errorMsg}</p>
      )}
    </div>
  )
}
