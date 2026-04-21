import { describe, it, expect } from 'vitest'
import { isValidEmail } from './email'

describe('isValidEmail', () => {
  it('accepts a standard email', () => {
    expect(isValidEmail('user@example.com')).toBe(true)
  })

  it('accepts subdomains', () => {
    expect(isValidEmail('user@mail.example.co.uk')).toBe(true)
  })

  it('accepts plus addressing', () => {
    expect(isValidEmail('user+tag@example.com')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidEmail('')).toBe(false)
  })

  it('rejects whitespace only', () => {
    expect(isValidEmail('   ')).toBe(false)
  })

  it('rejects bare @', () => {
    expect(isValidEmail('@')).toBe(false)
  })

  it('rejects missing @', () => {
    expect(isValidEmail('notanemail')).toBe(false)
  })

  it('rejects missing domain', () => {
    expect(isValidEmail('user@')).toBe(false)
  })

  it('rejects missing local part', () => {
    expect(isValidEmail('@example.com')).toBe(false)
  })

  it('rejects spaces in email', () => {
    expect(isValidEmail('user @example.com')).toBe(false)
  })

  it('rejects email over 254 chars', () => {
    const long = 'a'.repeat(243) + '@example.com'
    expect(long.length).toBeGreaterThan(254)
    expect(isValidEmail(long)).toBe(false)
  })

  it('accepts email exactly at 254 chars', () => {
    const local = 'a'.repeat(248)
    const email = `${local}@b.com`
    expect(email.length).toBe(254)
    expect(isValidEmail(email)).toBe(true)
  })
})
