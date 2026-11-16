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
 *
 * One job runs at a time, in one minimised window (redirect tabs are pulled
 * into it). When the user doesn't finish a review in time (CAPTCHA, sign-in),
 * the window is "parked": left open so their progress isn't lost, still
 * watched for a confirmation page, and the queue moves on. At MAX_PARKED
 * parked windows the queue pauses instead of piling up more windows.
 */

import { getState, setState } from '~lib/storage'
import { fetchNextJob, getAnswer, getProfile, getResumeFile, getResumeStatus, reportResult, revokeToken, verifyToken, whoAmI, type ReportStatus } from '~lib/api'

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

const MAX_PARKED = 3

/** A job window left open for the user to finish. */
interface Parked {
  job: any
  windowId: number
  tabIds: number[]
}

const getParked = async (): Promise<Parked[]> => (await chrome.storage.session.get('parked')).parked ?? []
const saveParked = (parked: Parked[]) => chrome.storage.session.set({ parked })

/** Parked windows that still exist (the user may have closed some). */
async function liveParked(): Promise<Parked[]> {
  const parked = await getParked()
  const live: Parked[] = []
  for (const p of parked) if (await chrome.windows.get(p.windowId).then(() => true, () => false)) live.push(p)
  if (live.length !== parked.length) await saveParked(live)
  return live
}

async function park(run: Run) {
  if (!(await chrome.windows.get(run.windowId).then(() => true, () => false))) return
  const parked = (await liveParked()).filter((p) => p.windowId !== run.windowId)
  await saveParked([...parked, { job: run.job, windowId: run.windowId, tabIds: run.tabIds }])
}

/** Pauses the queue while too many applications wait on the user. */
async function queuePaused(): Promise<boolean> {
  const n = (await liveParked()).length
  const { pausedNotified } = await chrome.storage.session.get('pausedNotified')
  if (n < MAX_PARKED) {
    if (pausedNotified) {
      await chrome.storage.session.remove('pausedNotified')
      await restoreBadge()
    }
    return false
  }
  if (!pausedNotified) {
    await chrome.storage.session.set({ pausedNotified: true })
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
    notify('Paused', `${n} applications are waiting for you (CAPTCHA or sign-in). Finish or close them and the queue continues.`)
  }
  return true
}

// ── Startup ──────────────────────────────────────────────────────────────────

const ensureAlarm = () => chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES })
chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return
  const run = await getRun()
  if (run) return checkDeadline(run)

  const { token, enabled } = await getState()
  if (!token || !enabled || (await queuePaused())) return
  await startNextJob().catch((e) => setState({ lastError: String(e?.message ?? e) }))
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
  else if (status === 'needs_manual') await park(run)
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
  const parked = await getParked()
  if (parked.some((p) => p.windowId === windowId)) {
    await saveParked(parked.filter((p) => p.windowId !== windowId))
    await queuePaused() // clears the pause once under the limit
  }
})

chrome.notifications.onClicked.addListener(async () => {
  // Bring up the current job, or else the oldest application waiting on the user.
  const windowId = (await getRun())?.windowId ?? (await liveParked())[0]?.windowId
  if (windowId) chrome.windows.update(windowId, { state: 'normal', focused: true }).catch(() => {})
})

// ── Messages from popup and content scripts ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }))
  return true
})

async function handle(msg: any, sender: chrome.runtime.MessageSender) {
  if (msg.type === 'VERIFY_TOKEN') return { ok: await verifyToken() }
  if (msg.type === 'RESUME_STATUS') return getResumeStatus()
  if (msg.type === 'WHO_AM_I') return whoAmI()
  if (msg.type === 'CONNECT_WITH_TOKEN') return connectWithToken(String(msg.token ?? ''), sender)
  if (msg.type === 'SIGN_OUT') {
    await revokeToken()
    await setState({ token: null, enabled: false })
    return { ok: true }
  }

  const run = await getRun()
  // Only the job's own tabs may act — a Greenhouse page the user opened
  // themselves must never be auto-filled.
  const fromJobTab = !!run && sender.tab?.id !== undefined && run.tabIds.includes(sender.tab.id)
  // …unless the user clicked "Autofill this page" for that tab.
  const adhoc = (await chrome.storage.session.get('adhoc')).adhoc as { tabId: number; profile: any; until: number } | undefined
  const fromAdhocTab = !!adhoc && adhoc.until > Date.now() && sender.tab?.id === adhoc.tabId
  // A parked window the user is finishing: only watched for confirmation.
  const parkedEntry = !fromJobTab && sender.tab?.id !== undefined
    ? (await getParked()).find((p) => p.tabIds.includes(sender.tab!.id!))
    : undefined

  switch (msg.type) {
    case 'AUTOFILL_TAB': {
      // From the popup: fill the form in the user's current tab, never submit.
      const tabId = Number(msg.tabId)
      if (!tabId) return { ok: false, error: 'No tab' }
      let profile: any
      try { profile = await getProfile() } catch (e: any) { return { ok: false, error: `Could not load your profile: ${e?.message ?? e}` } }
      await chrome.storage.session.set({ adhoc: { tabId, profile, until: Date.now() + 30 * 60_000 } })
      await chrome.tabs.sendMessage(tabId, { type: 'EA_FILL_NOW' }).catch(() => {})
      return { ok: true }
    }

    case 'GET_ADHOC_CONTEXT': {
      if (!fromAdhocTab) return null
      const { screening } = await getState()
      return { job: { $id: '', jobUrl: sender.tab?.url ?? '' }, profile: adhoc!.profile, screening, submitMode: 'review', phase: 'filling', submitting: false }
    }
    case 'GET_ACTIVE_JOB': {
      if (parkedEntry) return { job: parkedEntry.job, profile: {}, screening: {}, submitMode: 'review', phase: 'parked', submitting: false }
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
      if (!fromJobTab && !fromAdhocTab) return { answer: '' }
      const p = fromJobTab ? run!.profile : adhoc!.profile
      const context = JSON.stringify({
        job: fromJobTab ? { title: run!.job.jobTitle, company: run!.job.companyName } : { page: sender.tab?.title, url: sender.tab?.url },
        applicant: { title: p.professionalTitle, location: p.location, yearsOfExperience: p.yearsOfExperience, degree: p.highestDegree },
      })
      return { answer: await getAnswer(String(msg.question).slice(0, 600), context).catch(() => '') }
    }

    case 'GET_RESUME_FILE': {
      if (!fromJobTab && !fromAdhocTab) return null
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
      if (parkedEntry) {
        // The user finished a parked application — record it and tidy up.
        if (!msg.result?.success) return { ok: false }
        await saveParked((await getParked()).filter((p) => p.windowId !== parkedEntry.windowId))
        await reportResult({ queueId: parkedEntry.job.$id, jobUrl: parkedEntry.job.jobUrl, status: 'applied', resultDetails: { confirmationText: 'Submitted by you', page: sender.tab?.url } }).catch(() => {})
        const where = [parkedEntry.job.jobTitle, parkedEntry.job.companyName].filter(Boolean).join(' at ') || 'the job'
        notify('Applied!', `Recorded your application for ${where}.`)
        await incrementBadge()
        await queuePaused()
        return { ok: true }
      }
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

// ── Sign-in hand-off ─────────────────────────────────────────────────────────

/**
 * Saves a key handed over by the website's /extension/connect page. Only that
 * page, on the server this build talks to, may sign the extension in — a key
 * posted from any other site is refused. The key is checked with the server
 * before it replaces the current one.
 */
async function connectWithToken(token: string, sender: chrome.runtime.MessageSender) {
  const { apiBase, token: previous } = await getState()
  let from: URL | null = null
  try { from = new URL(sender.url ?? sender.tab?.url ?? '') } catch { from = null }
  const allowed = new URL(apiBase)
  const hostOk = from && from.protocol === allowed.protocol && (from.host === allowed.host || from.host === `www.${allowed.host}`)
  if (!hostOk || !from!.pathname.startsWith('/extension/connect') || sender.id !== chrome.runtime.id) {
    return { ok: false, error: 'Sign-in must come from the Elite Apply website' }
  }
  if (!/^[a-f0-9]{64}$/.test(token)) return { ok: false, error: 'Malformed key' }

  await setState({ token })
  const me = await whoAmI()
  if (!me) {
    await setState({ token: previous ?? null })
    return { ok: false, error: 'The server rejected the key' }
  }
  // Replacing an older key on this device: retire it on the server.
  if (previous && previous !== token) {
    await fetch(`${apiBase}/api/extension/auth/revoke`, { method: 'POST', headers: { 'X-Extension-Token': previous } }).catch(() => {})
  }
  await setState({ lastError: null })
  notify('Signed in', `Connected as ${me.email ?? 'your account'}.`)
  // Close the hand-off tab once the page has shown its confirmation.
  const tabId = sender.tab?.id
  if (tabId !== undefined) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 2500)
  return { ok: true, email: me.email }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function notify(title: string, message: string) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'assets/icon.png', title: `Elite Apply — ${title}`, message })
}

async function incrementBadge() {
  const { appliedCount = 0 } = await chrome.storage.local.get('appliedCount')
  await chrome.storage.local.set({ appliedCount: (appliedCount as number) + 1 })
  await restoreBadge()
}

async function restoreBadge() {
  const { pausedNotified } = await chrome.storage.session.get('pausedNotified')
  if (pausedNotified) return // the "!" stays while paused
  const { appliedCount = 0 } = await chrome.storage.local.get('appliedCount')
  chrome.action.setBadgeText({ text: appliedCount ? String(appliedCount) : '' })
  chrome.action.setBadgeBackgroundColor({ color: '#ea580c' })
}
