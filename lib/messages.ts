// Content-script side of the background protocol. Content scripts never call
// the API directly (CORS); they ask the background worker.

import type { FillContext, FillReport, Profile } from './autofill'
import type { ScreeningAnswers, SubmitMode } from './storage'

export interface ActiveJob {
  job: {
    $id: string
    jobUrl: string
    jobTitle?: string | null
    companyName?: string | null
    coverLetter?: string | null
  }
  profile: Profile
  screening: ScreeningAnswers
  submitMode: SubmitMode
  /** 'review' once the form waits for the user; submission is then theirs. */
  /** 'parked': the user is finishing it on their own — only watch for confirmation. */
  phase: 'filling' | 'review' | 'parked'
  /** True after the extension itself clicked Submit. */
  submitting: boolean
}

export interface JobResult {
  success: boolean
  /** Leave the window open and mark the job needs_manual instead of failed. */
  needsManual?: boolean
  error?: string
  confirmationText?: string
  report?: FillReport
}

const send = <T>(msg: Record<string, unknown>): Promise<T> => chrome.runtime.sendMessage(msg)

/** Returns the active job only when this tab is the job's tab. */
export const getActiveJob = () => send<ActiveJob | null>({ type: 'GET_ACTIVE_JOB' })

export const reportJobResult = (result: JobResult) => send({ type: 'JOB_RESULT', result })
export const requestReview = (report: FillReport, reason: string) => send({ type: 'NEEDS_REVIEW', report, reason })
/** Keeps the job alive while the flow moves to another page or tab. */
export const reportProgress = (note: string) => send({ type: 'JOB_PROGRESS', note })
/** Recorded before the extension clicks Submit, so the next page load can confirm it. */
export const markSubmitting = () => send({ type: 'MARK_SUBMITTING' })

/**
 * What this job is about, for picking the right résumé and grounding AI
 * answers: the queued title/company plus the page's own title and opening text.
 */
export function jobText(active: ActiveJob): string {
  const page = `${document.title}\n${(document.body?.innerText ?? '').slice(0, 4000)}`
  return [active.job.jobTitle, active.job.companyName, page].filter(Boolean).join('\n').slice(0, 6000)
}

export function buildFillContext(active: ActiveJob): FillContext {
  let resume: Promise<File | null> | null = null
  let label: string | undefined
  let letter: Promise<string> | null = null
  return {
    profile: active.profile,
    screening: active.screening,
    job: active.job,
    askAI: async (question) =>
      (await send<{ answer?: string }>({ type: 'ASK_AI', question, jobText: jobText(active) }))?.answer ?? '',
    getResumeFile: () => {
      resume ??= send<{ base64: string; name: string; type: string; label?: string } | null>({ type: 'GET_RESUME_FILE', jobText: jobText(active) }).then((f) => {
        if (!f?.base64) return null
        label = f.label
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
        return new File([bytes], f.name, { type: f.type })
      })
      return resume
    },
    resumeLabel: () => label,
    getCoverLetter: () => {
      letter ??= send<{ content?: string }>({ type: 'WRITE_COVER_LETTER', jobText: jobText(active) }).then((r) => r?.content ?? '').catch(() => '')
      return letter
    },
  }
}
