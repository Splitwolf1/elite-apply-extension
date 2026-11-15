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
  try {
    await apiFetch('/api/extension/auth/verify')
    return true
  } catch {
    return false
  }
}

/** Pull next queued job assigned to 'extension' executor */
export async function fetchNextJob() {
  return json('/api/extension/queue')
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

/** The user's résumé PDF as base64, ready to hand to a content script. */
export async function getResumeFile(): Promise<{ base64: string; name: string; type: string } | null> {
  const res = await apiFetch('/api/extension/resume/file')
  const type = res.headers.get('content-type') ?? 'application/pdf'
  const name = /filename="?([^";]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'resume.pdf'
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { base64: btoa(bin), name, type }
}
