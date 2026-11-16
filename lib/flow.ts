/**
 * One application flow, shared by every site: fill the visible step, advance
 * through multi-page forms, then either submit (auto mode, nothing missing) or
 * hand the filled form to the user (review mode / anything unresolved).
 */

import {
  fillForm, findNext, findSubmit, hasCaptcha, isConfirmationPage, needsLogin, setBannerRecheck, showReviewBanner,
  type FillContext, type FillReport,
} from './autofill'
import { markSubmitting, reportJobResult, reportProgress, requestReview, type ActiveJob } from './messages'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MAX_STEPS = 15

export interface FlowOptions {
  /** Element that contains the form (LinkedIn's modal); default document. */
  root?: () => ParentNode | null
  findSubmit?: () => HTMLElement | null | undefined
  findNext?: () => HTMLElement | null | undefined
  isConfirmation?: () => boolean
}

const merge = (a: FillReport, b: FillReport): FillReport => ({
  filled: a.filled + b.filled,
  unresolved: [...new Set([...a.unresolved, ...b.unresolved])],
  requiredUnresolved: b.requiredUnresolved, // the latest pass is the current truth
  resumeUploaded: a.resumeUploaded || b.resumeUploaded,
})

async function handOver(report: FillReport, reason: string) {
  showReviewBanner(report, report.requiredUnresolved.length ? 'blocked' : 'review', reason)
  await requestReview(report, reason)
}

/** Watches for the confirmation page after the user submits. */
export function watchForConfirmation(isConfirmation: () => boolean, report?: FillReport) {
  let done = false
  const check = () => {
    if (done || !isConfirmation()) return
    done = true
    observer.disconnect()
    clearInterval(timer)
    reportJobResult({ success: true, confirmationText: 'Submitted after review', report })
  }
  const observer = new MutationObserver(check)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  const timer = setInterval(check, 2000)
}

/**
 * Waits for the user to get past a sign-in wall. Single-page ATSs (Workday)
 * sign in without a reload, so poll: once the password field is gone and a
 * form is showing, run the flow again. A full page load restarts the content
 * script, which handles the same case itself.
 */
function resumeAfterSignIn(active: ActiveJob, ctx: FillContext, opts: FlowOptions, confirmed: () => boolean) {
  watchForConfirmation(confirmed)
  const started = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - started > 20 * 60_000) return clearInterval(timer)
    if (needsLogin()) return
    const fields = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,select,[role="combobox"]'))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
    if (fields.length < 3) return
    clearInterval(timer)
    document.getElementById('elite-apply-banner')?.remove()
    runFlow(active, ctx, opts)
  }, 2000)
}

export async function runFlow(active: ActiveJob, ctx: FillContext, opts: FlowOptions = {}) {
  const root = () => opts.root?.() ?? document
  const submitBtn = () => opts.findSubmit?.() ?? findSubmit(root())
  const nextBtn = () => opts.findNext?.() ?? findNext(root())
  const confirmed = opts.isConfirmation ?? isConfirmationPage

  let report: FillReport = { filled: 0, unresolved: [], requiredUnresolved: [], resumeUploaded: false }

  // "Check again" on the banner: after the user answers what we couldn't,
  // fill anything still empty and recount what's missing. Never submits.
  setBannerRecheck(async () => {
    const fresh = await fillForm(root(), ctx)
    const r = { ...merge(report, fresh), unresolved: fresh.unresolved } // only what's still empty
    report = r
    showReviewBanner(r, r.requiredUnresolved.length ? 'blocked' : 'review',
      r.requiredUnresolved.length ? 'Still missing a few answers.' : 'Everything required is filled.')
  })

  for (let step = 0; step < MAX_STEPS; step++) {
    if (needsLogin()) {
      await handOver(report, 'This site needs you to sign in or create an account — we never handle passwords. We will continue filling once you are in.')
      return resumeAfterSignIn(active, ctx, opts, confirmed)
    }

    // Two passes: answering one question often reveals follow-up fields.
    report = merge(report, await fillForm(root(), ctx))
    await sleep(700)
    report = merge(report, await fillForm(root(), ctx))

    if (hasCaptcha()) return handOver(report, 'This site shows a CAPTCHA — please complete it.')

    const submit = submitBtn()
    if (submit) {
      const blocked = report.requiredUnresolved.length > 0
      if (active.submitMode === 'auto' && !blocked) {
        await markSubmitting()
        submit.click()
        for (let i = 0; i < 15; i++) {
          await sleep(1000)
          if (confirmed()) return reportJobResult({ success: true, confirmationText: 'Submitted automatically', report })
        }
        // The page did not confirm: validation errors, or it navigated (the
        // next page load will confirm via `submitting`).
        return handOver(report, 'We clicked Submit but the site did not confirm — please check the form.')
      }
      await handOver(report, blocked ? 'A few required questions need your answer.' : 'Your application is ready.')
      return watchForConfirmation(confirmed, report)
    }

    const next = nextBtn()
    if (next) {
      if (report.requiredUnresolved.length) {
        await handOver(report, 'A few required questions need your answer before the next step.')
        return watchForConfirmation(confirmed, report)
      }
      next.click()
      await reportProgress(`step ${step + 1}`)
      await sleep(1800)
      report.requiredUnresolved = []
      continue
    }

    await handOver(report, 'We filled what we could but could not find the Submit button.')
    return watchForConfirmation(confirmed, report)
  }

  await handOver(report, 'This application has more steps than expected.')
  watchForConfirmation(confirmed, report)
}
