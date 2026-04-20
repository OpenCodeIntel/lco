'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useScroll, useMotionValueEvent } from 'framer-motion'
import ContextMeter from '@/components/ui/context-meter'
import type { HealthStatus } from '@/lib/tokens'

interface Turn {
  n: number
  user: string
  fill: number
  coaching?: string
  status: HealthStatus
}

const turns: Turn[] = [
  { n: 1, user: 'Build me a React component for the dashboard.', fill: 2, status: 'healthy' },
  { n: 4, user: 'Add TypeScript types and error handling.', fill: 8, status: 'healthy' },
  { n: 8, user: 'Now refactor the state management.', fill: 16, status: 'healthy' },
  { n: 12, user: 'Add unit tests using Vitest.', fill: 24, status: 'healthy' },
  { n: 16, user: 'Make it responsive for mobile.', fill: 34, status: 'healthy' },
  {
    n: 20,
    user: 'Add dark mode support.',
    fill: 46,
    status: 'healthy',
    coaching: 'Context at 46%. Still healthy, but this conversation is growing.',
  },
  {
    n: 24,
    user: 'Now add animations.',
    fill: 58,
    status: 'healthy',
    coaching: 'Consider starting a focused chat for the animation work.',
  },
  {
    n: 28,
    user: 'Integrate with the backend API.',
    fill: 70,
    status: 'degrading',
    coaching: 'Context degrading. Models lose precision past this threshold.',
  },
  {
    n: 32,
    user: 'Add authentication.',
    fill: 82,
    status: 'degrading',
    coaching: 'Start a new chat now. Carry only what the next task needs.',
  },
  {
    n: 36,
    user: 'Write the full test suite.',
    fill: 91,
    status: 'critical',
    coaching: 'Context nearly full. Start a new chat, or use Claude Projects.',
  },
  {
    n: 40,
    user: 'Oh wait, what were the TypeScript types from turn 4?',
    fill: 98,
    status: 'critical',
    coaching: 'The model has forgotten. This conversation is spent.',
  },
]

const STATUS_STYLE: Record<HealthStatus, { dot: string; glow: string; border: string; bg: string }> = {
  healthy: {
    dot: '#4caf50',
    glow: 'rgba(76, 175, 80, 0.35)',
    border: '#333333',
    bg: '#242424',
  },
  degrading: {
    dot: '#f5a623',
    glow: 'rgba(245, 166, 35, 0.4)',
    border: 'rgba(245, 166, 35, 0.28)',
    bg: 'rgb(34, 31, 26)',
  },
  critical: {
    dot: '#e53935',
    glow: 'rgba(229, 57, 53, 0.5)',
    border: 'rgba(229, 57, 53, 0.32)',
    bg: 'rgb(34, 26, 26)',
  },
}

export default function ContextRotDemo() {
  const containerRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const [currentIndex, setCurrentIndex] = useState(0)

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  })

  useMotionValueEvent(scrollYProgress, 'change', (latest) => {
    const index = Math.min(Math.floor(latest * turns.length), turns.length - 1)
    setCurrentIndex(index)
  })

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [currentIndex])

  const current = turns[currentIndex]
  const style = STATUS_STYLE[current.status]

  return (
    <div ref={containerRef} style={{ minHeight: '280vh' }}>
      <div className="sticky top-0 h-screen flex items-center border-t border-saar-border overflow-hidden">
        <section className="w-full">
          <div className="max-w-6xl mx-auto px-6">

            <div className="max-w-xl mb-10">
              <p className="font-mono text-xs text-saar-muted uppercase tracking-widest mb-4">
                Context rot in real time
              </p>
              <h2 className="font-serif text-4xl text-saar-text leading-tight">
                You start fresh. The model doesn&apos;t stay that way.
              </h2>
              <p className="mt-4 text-saar-secondary leading-relaxed">
                Every message you send adds to a context window with a hard limit.
                Past 70% utilization, frontier models start forgetting early context.
                Saar tracks it so you don&apos;t have to guess.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">

              {/* Left: simulated chat */}
              <div className="relative">
                <div
                  ref={chatRef}
                  className="space-y-2.5 overflow-y-auto"
                  style={{ maxHeight: '340px', scrollbarWidth: 'none' }}
                >
                  <AnimatePresence initial={false}>
                    {turns.slice(0, currentIndex + 1).map((turn, i) => {
                      const age = currentIndex - i
                      return (
                        <motion.div
                          key={turn.n}
                          initial={{ opacity: 0, y: 20, scale: 0.97 }}
                          animate={{
                            opacity: age > 3 ? 0.3 : age > 1 ? 0.6 : 1,
                            y: 0,
                            scale: 1,
                          }}
                          exit={{ opacity: 0, y: -10, scale: 0.97 }}
                          transition={{ duration: 0.38, ease: [0.25, 0.1, 0.25, 1] }}
                          className="rounded-lg border border-saar-border bg-saar-card p-3"
                        >
                          <span className="font-mono text-[10px] text-saar-muted block mb-1">
                            turn {turn.n}
                          </span>
                          <p className="text-sm text-saar-text">{turn.user}</p>
                        </motion.div>
                      )
                    })}
                  </AnimatePresence>
                </div>
                <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-saar-bg to-transparent pointer-events-none" />
                <div className="absolute bottom-0 left-0 right-0 h-14 bg-gradient-to-t from-saar-bg to-transparent pointer-events-none" />
              </div>

              {/* Right: live Saar card */}
              <motion.div
                className="rounded-xl border p-5"
                animate={{
                  borderColor: style.border,
                  backgroundColor: style.bg,
                }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
              >
                <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-saar-accent mb-4">
                  S A A R
                </div>

                <div className="flex items-center gap-2 mb-3">
                  <motion.span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    animate={{
                      backgroundColor: style.dot,
                      boxShadow: `0 0 7px 2px ${style.glow}`,
                    }}
                    transition={{ duration: 0.6 }}
                  />
                  <AnimatePresence mode="wait">
                    <motion.span
                      key={current.status}
                      initial={{ opacity: 0, y: -5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 5 }}
                      transition={{ duration: 0.22 }}
                      className="text-sm capitalize text-saar-secondary"
                    >
                      {current.status}
                    </motion.span>
                  </AnimatePresence>
                  <span className="ml-auto font-mono text-xs text-saar-muted">
                    turn {current.n} / 40
                  </span>
                </div>

                <ContextMeter
                  fill={current.fill}
                  status={current.status}
                  label={`${current.fill}% context`}
                  className="mb-4"
                />

                <AnimatePresence mode="wait">
                  {current.coaching ? (
                    <motion.div
                      key={current.coaching}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.3 }}
                      className="rounded-md bg-saar-hover border border-saar-border p-3 text-sm text-saar-secondary leading-relaxed"
                    >
                      {current.coaching}
                    </motion.div>
                  ) : (
                    <motion.div key="empty" className="h-12" />
                  )}
                </AnimatePresence>
              </motion.div>
            </div>

            {/* Scroll hint */}
            <AnimatePresence>
              {currentIndex === 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: 0.6, duration: 0.4 }}
                  className="flex items-center gap-2 justify-center mt-10"
                >
                  <span className="font-mono text-xs text-saar-muted">
                    scroll to watch context fill
                  </span>
                  <motion.span
                    animate={{ y: [0, 5, 0] }}
                    transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
                    className="font-mono text-xs text-saar-muted"
                  >
                    ↓
                  </motion.span>
                </motion.div>
              )}
            </AnimatePresence>

          </div>
        </section>
      </div>
    </div>
  )
}
