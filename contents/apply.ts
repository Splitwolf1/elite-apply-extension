import type { PlasmoCSConfig } from 'plasmo'
import { fillForm, findApplyEntry, isConfirmationPage, isVisible, needsLogin, questionText, setBannerRecheck, showReviewBanner, type FillContext } from '~lib/autofill'
import { buildFillContext, getActiveJob, reportJobResult, reportProgress, requestReview, type ActiveJob } from '~lib/messages'
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
  if (!active) {
    // Not a queued job — but maybe the user pressed "Autofill this page" and
    // this is the application the job page opened (e.g. Workday).
    const adhoc = await chrome.runtime.sendMessage({ type: 'GET_ADHOC_CONTEXT' }).catch(() => null)
    if (adhoc) startAdhoc(adhoc)
    return
  }

  // Parked: the user is finishing this one themselves. Touch nothing; just
  // record it when the confirmation page shows up.
  if (active.phase === 'parked') {
    if (isTop) watchForConfirmation(isConfirmationPage)
    return
  }

  // A confirmation page after our own submit, or after the user's review.
  if ((active.submitting || active.phase === 'review') && isConfirmationPage()) {
    if (isTop) await reportJobResult({ success: true, confirmationText: active.submitting ? 'Submitted automatically' : 'Submitted after review' })
    return
  }
  const ctx = buildFillContext(active)

  if (active.phase === 'review') {
    // The user took over (sign-in, CAPTCHA, a question we couldn't answer).
    // When their action leads to a new page with a form — e.g. after signing
    // in to Workday — fill it again: only empty fields are touched, so
    // nothing the user typed is overwritten. Otherwise just watch for submit.
    if (!needsLogin() && (await waitForForm(4000))) return runFlow(active, ctx)
    if (isTop) watchForConfirmation(isConfirmationPage)
    return
  }

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

// ── "Autofill this page" ──────────────────────────────────────────────────────
// Started from the popup on whatever page the user is on. Never submits.
// On a job description it clicks Apply; on the application (also after the
// user signs in, and on every new step) it fills fields as they appear.

let adhocRunning = false

/** Fields we've already seen, so we only refill when new ones appear. */
const fieldKey = (el: Element) =>
  `${(el as HTMLInputElement).name || el.id || ''}|${questionText(el as HTMLElement).slice(0, 60)}`

function startAdhoc(active: ActiveJob, first?: (r: Record<string, unknown>) => void) {
  if (adhocRunning) return
  adhocRunning = true
  const ctx: FillContext = buildFillContext(active)
  const seen = new Set<string>()
  let lastReport: Awaited<ReturnType<typeof fillForm>> | null = null
  let loginShown = false

  const fill = async () => {
    const fields = Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(isVisible)
    fields.forEach((f) => seen.add(fieldKey(f)))
    const r = await fillForm(document, ctx)
    lastReport = r
    if (r.filled || r.unresolved.length) {
      showReviewBanner(r, r.requiredUnresolved.length ? 'blocked' : 'review')
    }
    return r
  }
  setBannerRecheck(async () => { await fill() })

  ;(async () => {
    // First look, answered to the popup (top frame only).
    if (needsLogin()) {
      if (isTop) {
        showReviewBanner({ filled: 0, unresolved: [], requiredUnresolved: [], resumeUploaded: false }, 'blocked',
          'Sign in or create your account on this site — we never handle passwords. We\'ll fill the application as soon as it appears.')
        loginShown = true
      }
      first?.({ kind: 'login' })
    } else if (countFields() >= 2) {
      const r = await fill()
      first?.({ kind: 'filled', filled: r.filled, missing: r.requiredUnresolved, resumeUploaded: r.resumeUploaded, resumeLabel: r.resumeLabel })
    } else if (isTop) {
      const formUrl = atsFormUrl()
      const entry = formUrl ? null : findApplyEntry()
      if (formUrl) {
        first?.({ kind: 'opening' })
        location.href = formUrl
        return
      } else if (hasAtsIframe()) {
        first?.({ kind: 'iframe' })
      } else if (entry) {
        first?.({ kind: 'opening' })
        entry.click()
      } else {
        first?.({ kind: 'none' })
      }
    }

    // Keep going for 20 minutes: sign-in walls, multi-step forms, SPAs.
    const end = Date.now() + 20 * 60_000
    while (Date.now() < end) {
      await sleep(2500)
      if (isConfirmationPage()) {
        document.getElementById('elite-apply-banner')?.remove()
        return
      }
      if (needsLogin()) continue
      if (loginShown) { loginShown = false; document.getElementById('elite-apply-banner')?.remove() }
      const fields = Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(isVisible)
      if (fields.length < 2) continue
      if (fields.some((f) => !seen.has(fieldKey(f)))) await fill() // a new step or newly revealed questions
    }
    void lastReport
  })().catch(() => {})
}

// The popup's "Check this job": the top frame returns the page's text.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'EA_PAGE_TEXT' || !isTop) return
  sendResponse({ title: document.title, url: location.href, text: (document.body?.innerText ?? '').slice(0, 20000) })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'EA_FILL_NOW') return
  ;(async () => {
    const active = await chrome.runtime.sendMessage({ type: 'GET_ADHOC_CONTEXT' }).catch(() => null)
    if (!active) { if (isTop) sendResponse({ kind: 'error' }); return }
    if (adhocRunning) {
      // Pressed again on the same page: fill whatever is empty now.
      const r = await fillForm(document, buildFillContext(active))
      if (r.filled || r.unresolved.length) showReviewBanner(r, r.requiredUnresolved.length ? 'blocked' : 'review')
      if (isTop) sendResponse({ kind: 'filled', filled: r.filled, missing: r.requiredUnresolved, resumeUploaded: r.resumeUploaded, resumeLabel: r.resumeLabel })
      return
    }
    startAdhoc(active, isTop ? sendResponse : undefined)
  })().catch(() => { if (isTop) sendResponse({ kind: 'error' }) })
  return isTop // only the top frame answers the popup
})

main().catch((e) => {
  if (isTop) reportJobResult({ success: false, needsManual: true, error: String(e?.message ?? e) })
})
