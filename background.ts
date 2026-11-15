/**
 * Background service worker — runs one queued application at a time.
 *
 * MV3 service workers are killed after ~30 s idle, so nothing here waits on an
 * in-memory promise. The current run lives in chrome.storage.session and every
 * event (alarm, message, new tab) re-reads it. Phases:
 *
 *   filling — content scripts are working; deadline FILL_MS, extended while
 *             the flow moves between pages/tabs (LinkedIn → company site).
 *   review  — form is filled and waits for the user to submit; window is
 *             shown; deadline REVIEW_MS. Submission is detected on the
 *             confirmation page and reported as applied.
 */

import { getState, setState } from '~lib/storage'
import { fetchNextJob, getAnswer, getProfile, getResumeFile, reportResult, verifyToken, type ReportStatus } from '~lib/api'

export {}

const ALARM_NAME = 'poll-queue'
const POLL_INTERVAL_MINUTES = 1
const FILL_MS = 4 * 60_000
const REVIEW_MS = 20 * 60_000

interface Run {
  job: any
  profile: any
  windowId: number
  tabIds: number[]
  phase: 'filling' | 'review'
  submitting?: boolean
  deadline: number
}

const getRun = async (): Promise<Run | null> => (await chrome.storage.session.get('run')).run ?? null
const saveRun = (run: Run | null) => (run ? chrome.storage.session.set({ run }) : chrome.storage.session.remove(['run', 'resume']))

// ── Startup ──────────────────────────────────────────────────────────────────

const ensureAlarm = () => chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES })
chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return
  const run = await getRun()
  if (run) return checkDeadline(run)

  const { token, enabled } = await getState()
  if (token && enabled) await startNextJob().catch((e) => setState({ lastError: String(e?.message ?? e) }))
})

async function checkDeadline(run: Run) {
  if (Date.now() < run.deadline) return
  if (run.phase === 'review') {
    // Leave the window: the user may be mid-way through the form.
    await finish(run, 'needs_manual', { error: 'Waiting for you to review and submit' }, false)
  } else {
    await finish(run, 'failed', { error: 'Timed out filling the application' }, true)
  }
}

async function startNextJob() {
  const data = await fetchNextJob()
  const job = data?.job ?? null
  if (!job?.jobUrl) return

  let profile: any
  try {
    profile = await getProfile()
  } catch (e: any) {
    await reportResult({ queueId: job.$id, jobUrl: job.jobUrl, status: 'needs_manual', resultDetails: { error: `Profile unavailable: ${e?.message ?? e}` } }).catch(() => {})
    return
  }

  // Dedicated minimised window — never touches the user's own tabs.
  const win = await chrome.windows.create({ url: job.jobUrl, focused: false, state: 'minimized' })
  const tabId = win.tabs?.[0]?.id
  if (!win.id || !tabId) throw new Error('Could not open a window for the job')

  await saveRun({ job, profile, windowId: win.id, tabIds: [tabId], phase: 'filling', deadline: Date.now() + FILL_MS })
  await setState({ lastError: null })
}

/** Reports the outcome and clears the run. */
async function finish(run: Run, status: ReportStatus, details: Record<string, unknown>, closeWindow: boolean) {
  await saveRun(null)
  await reportResult({ queueId: run.job.$id, jobUrl: run.job.jobUrl, status, resultDetails: details }).catch(() => {})

  const where = [run.job.jobTitle, run.job.companyName].filter(Boolean).join(' at ') || 'the job'
  if (status === 'applied') {
    notify('Applied!', `Submitted your application for ${where}.`)
    await incrementBadge()
  } else if (status === 'needs_manual') {
    notify('Needs you', `${where}: ${details.error ?? 'finish this application yourself'}.`)
  }
  if (closeWindow) await chrome.windows.remove(run.windowId).catch(() => {})
}

// ── Follow redirects into new tabs (LinkedIn/Indeed "Apply on company site") ─

chrome.tabs.onCreated.addListener(async (tab) => {
  const run = await getRun()
  if (!run || !tab.id || tab.openerTabId === undefined || !run.tabIds.includes(tab.openerTabId)) return
  run.tabIds.push(tab.id)
  run.deadline = Math.max(run.deadline, Date.now() + FILL_MS)
  await saveRun(run)
  // Keep the flow inside the job window.
  if (tab.windowId !== run.windowId) await chrome.tabs.move(tab.id, { windowId: run.windowId, index: -1 }).catch(() => {})
})

chrome.windows.onRemoved.addListener(async (windowId) => {
  const run = await getRun()
  if (run?.windowId === windowId) await finish(run, 'needs_manual', { error: 'Application window was closed' }, false)
})

chrome.notifications.onClicked.addListener(async () => {
  const run = await getRun()
  if (run) chrome.windows.update(run.windowId, { state: 'normal', focused: true }).catch(() => {})
})

// ── Messages from popup and content scripts ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }))
  return true
})

async function handle(msg: any, sender: chrome.runtime.MessageSender) {
  if (msg.type === 'VERIFY_TOKEN') return { ok: await verifyToken() }

  const run = await getRun()
  // Only the job's own tabs may act — a Greenhouse page the user opened
  // themselves must never be auto-filled.
  const fromJobTab = !!run && sender.tab?.id !== undefined && run.tabIds.includes(sender.tab.id)

  switch (msg.type) {
    case 'GET_ACTIVE_JOB': {
      if (!fromJobTab) return null
      const { screening, submitMode } = await getState()
      return { job: run!.job, profile: run!.profile, screening, submitMode, phase: run!.phase, submitting: !!run!.submitting }
    }

    case 'MARK_SUBMITTING': {
      if (!fromJobTab) return { ok: false }
      run!.submitting = true
      run!.deadline = Math.max(run!.deadline, Date.now() + FILL_MS)
      await saveRun(run)
      return { ok: true }
    }

    case 'ASK_AI': {
      if (!fromJobTab) return { answer: '' }
      const p = run!.profile
      const context = JSON.stringify({
        job: { title: run!.job.jobTitle, company: run!.job.companyName },
        applicant: { title: p.professionalTitle, location: p.location, yearsOfExperience: p.yearsOfExperience, degree: p.highestDegree },
      })
      return { answer: await getAnswer(String(msg.question).slice(0, 600), context).catch(() => '') }
    }

    case 'GET_RESUME_FILE': {
      if (!fromJobTab) return null
      const cached = (await chrome.storage.session.get('resume')).resume
      if (cached) return cached
      const file = await getResumeFile().catch(() => null)
      if (file) await chrome.storage.session.set({ resume: file })
      return file
    }

    case 'JOB_PROGRESS': {
      if (!fromJobTab) return { ok: false }
      run!.deadline = Math.max(run!.deadline, Date.now() + FILL_MS)
      await saveRun(run)
      return { ok: true }
    }

    case 'NEEDS_REVIEW': {
      if (!fromJobTab) return { ok: false }
      if (run!.phase !== 'review') {
        run!.phase = 'review'
        run!.deadline = Date.now() + REVIEW_MS
        await saveRun(run)
        await chrome.windows.update(run!.windowId, { state: 'normal', focused: true }).catch(() => {})
        if (sender.tab?.id) chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {})
        notify('Review & submit', `${msg.reason ?? 'Your application is filled'} — check it and click Submit.`)
      }
      return { ok: true }
    }

    case 'JOB_RESULT': {
      if (!fromJobTab) return { ok: false }
      const r = msg.result ?? {}
      const details = { error: r.error, confirmationText: r.confirmationText, filled: r.report?.filled, unresolved: r.report?.unresolved, page: sender.tab?.url }
      if (r.success) await finish(run!, 'applied', details, true)
      else await finish(run!, r.needsManual ? 'needs_manual' : 'failed', details, !r.needsManual)
      return { ok: true }
    }
  }
  return null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function notify(title: string, message: string) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'assets/icon.png', title: `Elite Apply — ${title}`, message })
}

async function incrementBadge() {
  const { appliedCount = 0 } = await chrome.storage.local.get('appliedCount')
  const next = (appliedCount as number) + 1
  await chrome.storage.local.set({ appliedCount: next })
  chrome.action.setBadgeText({ text: String(next) })
  chrome.action.setBadgeBackgroundColor({ color: '#ea580c' })
}
