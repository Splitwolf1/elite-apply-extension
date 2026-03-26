// Calls to the Elite Apply API, authenticated via X-Extension-Token header

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
  return res.json()
}

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
  return apiFetch('/api/extension/queue')
}

/** Report the result of an application attempt */
export async function reportResult(payload: {
  queueId: string
  jobUrl: string
  status: 'applied' | 'failed' | 'needs_manual'
  error?: string
  confirmationText?: string
}) {
  return apiFetch('/api/extension/report', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** Get cached answer for a form question (or generate one) */
export async function getAnswer(question: string, context: string): Promise<string> {
  const data = await apiFetch('/api/extension/answers', {
    method: 'POST',
    body: JSON.stringify({ question, context }),
  })
  return data.answer as string
}

/** Get resume data / signed URL for upload */
export async function getResume() {
  return apiFetch('/api/extension/resume')
}
