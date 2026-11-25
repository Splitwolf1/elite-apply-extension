// Calls to the Elite Apply API, authenticated via X-Extension-Token header.
// Only the background service worker calls these: a content script's fetch
// runs under the job site's origin and is blocked by CORS.

import { getState } from './storage'

async function apiFetch(path: string, init?: RequestInit) {
  const { token, apiBase } = await getState()
  if (!token) throw new Error('No token configured')

  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-Token': token,
      ...(init?.headers ?? {}),
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text)
  }
  return res
}

const json = async (path: string, init?: RequestInit) => (await apiFetch(path, init)).json()

/** Verify that the stored token is still valid */
export async function verifyToken(): Promise<boolean> {
  return (await whoAmI()) !== null
}

/** The account the stored key signs in as, or null when not signed in. */
export async function whoAmI(): Promise<{ email: string | null; name: string | null } | null> {
  try {
    const r = await json('/api/extension/auth/verify')
    return { email: r.email ?? null, name: r.name ?? null }
  } catch {
    return null
  }
}

/** Sign out: deactivate this device's key on the server. */
export async function revokeToken(): Promise<void> {
  await apiFetch('/api/extension/auth/revoke', { method: 'POST' }).catch(() => {})
}

/** Whether a résumé file is set up to attach to applications. */
export async function getResumeStatus(): Promise<{ hasFile: boolean; fileName: string | null; count: number; labels: string[] }> {
  try {
    const r = await json('/api/extension/resume')
    return { hasFile: !!r.hasFile, fileName: r.fileName ?? null, count: r.count ?? (r.hasFile ? 1 : 0), labels: r.labels ?? [] }
  } catch {
    return { hasFile: false, fileName: null, count: 0, labels: [] } // 404 = no résumé at all
  }
}

const tz = () => new Date().getTimezoneOffset()

/** Next queued job for the extension. The server applies the user's site rules and daily caps. */
export async function fetchNextJob(): Promise<{ job: any | null; capped?: boolean }> {
  return json(`/api/extension/queue?tz=${tz()}`)
}

export interface Schedule { mode: 'whenOpen' | 'times'; times: string[]; night: boolean }
export interface SiteRow { id: string; label: string; on: boolean; mode: 'assist' | 'auto'; cap: number; used: number }
export interface Overview { sentToday: number; inLine: number; needsYou: number; schedule: Schedule; sites: SiteRow[] }

/** Today's numbers, the schedule and per-site rules with today's usage. */
export async function getOverview(): Promise<Overview> {
  return json(`/api/extension/overview?tz=${tz()}`)
}

export interface NavStep { action: 'click' | 'stop' | 'done'; i?: number; why?: string }
/** One AI navigator step: which numbered element to click, or stop. */
export async function navigate(page: Record<string, unknown>): Promise<NavStep> {
  try { return await json('/api/extension/navigate', { method: 'POST', body: JSON.stringify(page) }) }
  catch { return { action: 'stop', why: 'The navigator is unavailable right now' } }
}

/** Flat applicant profile used to fill forms */
export async function getProfile() {
  return json('/api/extension/profile')
}

export type ReportStatus = 'applied' | 'failed' | 'needs_manual'

/** Report the result of an application attempt */
export async function reportResult(payload: {
  queueId: string
  jobUrl: string
  status: ReportStatus
  resultDetails?: Record<string, unknown>
}) {
  return json('/api/extension/report', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** Get cached answer for a form question (or generate one) */
export async function getAnswer(question: string, context: string): Promise<string> {
  const data = await json('/api/extension/answers', {
    method: 'POST',
    body: JSON.stringify({ question, context }),
  })
  return (data.answer as string) ?? ''
}

/**
 * The résumé to attach, as base64 for a content script. With `jobText` the
 * server picks the user's résumé that best fits this job (e.g. their AI one
 * vs their full-stack one); without it, their default.
 */
export async function getResumeFile(jobText = ''): Promise<{ base64: string; name: string; type: string; label?: string } | null> {
  const res = await apiFetch('/api/extension/resume/file', { method: 'POST', body: JSON.stringify({ jobText }) })
  const type = res.headers.get('content-type') ?? 'application/pdf'
  const name = /filename="?([^";]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'resume.pdf'
  let label: string | undefined
  try { label = decodeURIComponent(res.headers.get('x-resume-label') ?? '') || undefined } catch { label = undefined }
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { base64: btoa(bin), name, type, label }
}

/** A cover letter for the form being filled, written from the user's résumé. Empty when unavailable. */
export async function writeCoverLetter(jobTitle: string, company: string, jobText: string): Promise<string> {
  try {
    const r = await json('/api/extension/cover-letter', { method: 'POST', body: JSON.stringify({ jobTitle, company, jobText }) })
    return String(r.content ?? '')
  } catch {
    return '' // no plan, writer down: the field stays for the user
  }
}

export interface AtsSummary {
  score: number; have: string[]; missing: string[]
  visa: 'sponsors' | 'no-sponsorship' | 'unknown'; years: { required: number | null; yours: number | null }
  region: 'us' | 'ca' | 'uk' | 'eu' | null; resumeLabel: string | null
  flags?: { kind: string; label: string; quote: string; blocking: boolean }[]
}
/** ATS check of a job page against the résumé that would be attached. */
export async function atsCheck(jobText: string): Promise<AtsSummary> {
  const res = await fetch(`${(await getState()).apiBase}/api/extension/ats`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Extension-Token': (await getState()).token ?? '' },
    body: JSON.stringify({ jobText }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Check failed')
  return data as AtsSummary
}
