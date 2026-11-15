// Typed wrappers around chrome.storage.local

/** How a filled application is finished. */
export type SubmitMode = 'review' | 'auto'

/**
 * Answers the extension must never guess. The user sets them once in the
 * popup; anything left null is flagged for review on the form instead.
 */
export interface ScreeningAnswers {
  workAuthorized: boolean | null      // legally authorized to work in the job's country
  needsSponsorship: boolean | null    // now or in the future
  willingToRelocate: boolean | null
  salaryExpectation: string           // free text, e.g. "120000" or "Negotiable"
  noticePeriod: string                // e.g. "2 weeks"
  howDidYouHear: string               // e.g. "LinkedIn"
  // EEO: 'decline' answers every voluntary self-identification question with
  // the form's "prefer not to say" option.
  eeo: 'decline'
}

export interface ExtensionState {
  token: string | null
  enabled: boolean
  apiBase: string
  lastError: string | null
  submitMode: SubmitMode
  screening: ScreeningAnswers
}

export const DEFAULT_SCREENING: ScreeningAnswers = {
  workAuthorized: null,
  needsSponsorship: null,
  willingToRelocate: null,
  salaryExpectation: '',
  noticePeriod: '',
  howDidYouHear: 'LinkedIn',
  eeo: 'decline',
}

const DEFAULTS: ExtensionState = {
  token: null,
  enabled: false,
  apiBase: process.env.PLASMO_PUBLIC_API_BASE ?? 'https://aijobtoolkit.com',
  lastError: null,
  submitMode: 'review',
  screening: DEFAULT_SCREENING,
}

export async function getState(): Promise<ExtensionState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (items) => {
      const s = items as ExtensionState
      // Merge so newly added screening keys get defaults for existing installs
      resolve({ ...s, screening: { ...DEFAULT_SCREENING, ...(s.screening ?? {}) } })
    })
  })
}

export async function setState(partial: Partial<ExtensionState>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(partial, resolve)
  })
}
