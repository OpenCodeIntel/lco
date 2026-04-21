import type { Metadata } from 'next'
import { Instrument_Serif } from 'next/font/google'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import Nav from '@/components/nav'
import CmdPalette from '@/components/cmd-palette'
import './globals.css'

const instrumentSerif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--font-instrument-serif',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Saar · AI Usage Coach',
  description:
    'Platforms sell compute. Saar helps you use less of it. The AI usage coach for Claude, ChatGPT, and every tool coming next.',
  metadataBase: new URL('https://getsaar.com'),
  openGraph: {
    title: 'Saar · AI Usage Coach',
    description: 'An AI usage coach for people who actually notice.',
    url: 'https://getsaar.com',
    siteName: 'Saar',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Saar · AI Usage Coach',
    description: 'An AI usage coach for people who actually notice.',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="bg-saar-bg text-saar-text font-sans antialiased">
        <Nav />
        <CmdPalette />
        <main>{children}</main>
      </body>
    </html>
  )
}
