import { Resend } from 'resend'
import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

interface WaitlistBody {
  email: string
}

// Per-instance rate limiter: max 5 submissions per IP per 60s window.
// In-memory — resets on cold start. Production: replace with Vercel KV or middleware.
const ipLog = new Map<string, { count: number; windowStart: number }>()
const RATE_LIMIT = 5
const WINDOW_MS = 60_000

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = ipLog.get(ip)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    ipLog.set(ip, { count: 1, windowStart: now })
    return false
  }
  if (entry.count >= RATE_LIMIT) return true
  entry.count++
  return false
}

export async function POST(request: Request): Promise<NextResponse> {
  const headersList = await headers()
  const ip =
    headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headersList.get('x-real-ip') ??
    'unknown'

  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  let body: WaitlistBody

  try {
    body = (await request.json()) as WaitlistBody
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!email || !emailRegex.test(email) || email.length > 254) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 })
  }

  const apiKey = process.env.RESEND_API_KEY
  const audienceId = process.env.RESEND_AUDIENCE_ID

  if (!apiKey || !audienceId) {
    return NextResponse.json({ error: 'Waitlist not configured' }, { status: 500 })
  }

  const resend = new Resend(apiKey)

  try {
    await resend.contacts.create({
      email,
      audienceId,
      unsubscribed: false,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Resend error:', err)
    return NextResponse.json({ error: 'Failed to join waitlist' }, { status: 500 })
  }
}
