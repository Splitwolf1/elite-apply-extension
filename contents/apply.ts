import type { PlasmoCSConfig } from 'plasmo'
import { findApplyEntry, isConfirmationPage, isVisible } from '~lib/autofill'
import { buildFillContext, getActiveJob, reportJobResult, reportProgress, requestReview } from '~lib/messages'
import { runFlow, watchForConfirmation } from '~lib/flow'
import { getState } from '~lib/storage'

/**
 * Universal applier for external applications: any ATS (Greenhouse, Lever,
 * Ashby, Workday, SmartRecruiters, Workable, iCIMS, BambooHR, …) or company
 * career site. Runs in every frame (Greenhouse embeds its form in an iframe)
 * but acts only inside the job's own tab — the background checks the tab.
 */
export const config: PlasmoCSConfig = {
  matches: ['<all_urls>'],
  all_frames: true,
  run_at: 'document_idle',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isTop = window.top === window
const host = location.hostname.toLowerCase()

// LinkedIn and Indeed job pages have their own scripts.
const SKIP = host === 'www.linkedin.com' || host === 'www.indeed.com'

const FIELD_SELECTOR =
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]),textarea,select,[role="combobox"]'

function countFields() {
  return Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(isVisible).length
}

async function waitForForm(timeoutMs: number) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (countFields() >= 3) return true
    await sleep(500)
  }
  return false
}

/** Some ATSs put the form on a sibling URL of the job description. */
function atsFormUrl(): string | null {
  const path = location.pathname.replace(/\/$/, '')
  if (host === 'jobs.lever.co' && /^\/[^/]+\/[0-9a-f-]{36}$/i.test(path)) return `${location.origin}${path}/apply`
  if (host === 'jobs.ashbyhq.com' && /^\/[^/]+\/[0-9a-f-]{36}$/i.test(path)) return `${location.origin}${path}/application`
  return null
}

const hasAtsIframe = () =>
  Array.from(document.querySelectorAll('iframe')).some((f) => /greenhouse|lever|ashby|workable|smartrecruiters|icims|jobvite/i.test(f.src))

async function main() {
  if (SKIP) return
  const { enabled } = await getState()
  if (!enabled) return

  const active = await getActiveJob()
  if (!active) return

  // A confirmation page after our own submit, or after the user's review.
  if ((active.submitting || active.phase === 'review') && isConfirmationPage()) {
    if (isTop) await reportJobResult({ success: true, confirmationText: active.submitting ? 'Submitted automatically' : 'Submitted after review' })
    return
  }
  if (active.phase === 'review') {
    // User is reviewing; just keep watching for their submission.
    if (isTop) watchForConfirmation(isConfirmationPage)
    return
  }

  const ctx = buildFillContext(active)

  if (await waitForForm(isTop ? 8000 : 6000)) {
    return runFlow(active, ctx)
  }

  // No form here. Frames other than the top one stay quiet.
  if (!isTop) return

  const formUrl = atsFormUrl()
  if (formUrl) {
    await reportProgress('opening application form')
    location.href = formUrl
    return
  }

  if (hasAtsIframe()) return // the form lives in an iframe; its script runs

  const entry = findApplyEntry()
  if (entry) {
    await reportProgress('opening application')
    entry.click()
    // Same-page forms (modals, SPAs) appear in place; navigation reloads us.
    if (await waitForForm(8000)) return runFlow(active, ctx)
    return
  }

  await requestReview(
    { filled: 0, unresolved: [], requiredUnresolved: [], resumeUploaded: false },
    "We couldn't find the application form on this page",
  )
  watchForConfirmation(isConfirmationPage)
}

main().catch((e) => {
  if (isTop) reportJobResult({ success: false, needsManual: true, error: String(e?.message ?? e) })
})
