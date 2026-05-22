import { getState, setState } from '~lib/storage'
import { verifyToken, fetchNextJob, reportResult } from '~lib/api'

export {}

const ALARM_NAME           = 'poll-queue'
const POLL_INTERVAL_MINUTES = 1          // every 60 seconds (not 30 — too aggressive)
const APPLY_TIMEOUT_MS      = 45_000     // 45 s max per job before giving up

// Prevent concurrent job processing
let _processing = false

// ── Startup / install ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES })
})

// ── Alarm handler — poll for pending jobs ─────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return
  if (_processing) return  // skip if already running

  const { token, enabled } = await getState()
  if (!token || !enabled) return

  _processing = true
  try {
    await pollAndProcess()
  } finally {
    _processing = false
  }
})

async function pollAndProcess() {
  let jobWindow: chrome.windows.Window | null = null
  let jobTabId: number | null = null
  let job: any = null

  try {
    const data = await fetchNextJob()
    job = data?.job ?? data  // handle both { job } and direct object
    if (!job?.jobUrl) return  // nothing queued

    // ── Open the job URL in a SEPARATE minimised window ───────────────────
    // This never touches the user's current browser window or their tabs.
    jobWindow = await chrome.windows.create({
      url:     job.jobUrl,
      focused: false,
      state:   'minimized',
    })
    jobTabId = jobWindow.tabs?.[0]?.id ?? null

    if (!jobTabId) {
      throw new Error('Could not get tab ID from new window')
    }

    // Store so content scripts can pick it up
    await chrome.storage.session.set({ activeJob: job, tabId: jobTabId })
    await setState({ lastError: null })

    // Wait for the content script to report back, or timeout
    const result = await waitForResult(jobTabId, APPLY_TIMEOUT_MS)

    await reportResult({
      queueId:          job.$id,
      jobUrl:           job.jobUrl,
      status:           result.success ? 'applied' : 'failed',
      error:            result.error,
      confirmationText: result.confirmationText,
    })

    if (result.success) {
      showNotification('Applied!', `Successfully applied to ${job.jobTitle ?? 'job'} at ${job.companyName ?? ''}`)
      await incrementBadge()
    }

  } catch (err: any) {
    console.error('[EliteApply] Processing error:', err)
    await setState({ lastError: err?.message ?? String(err) })

    // Report failure if we have a job
    if (job?.$id) {
      await reportResult({
        queueId: job.$id,
        jobUrl:  job.jobUrl ?? '',
        status:  'failed',
        error:   err?.message ?? String(err),
      }).catch(() => {})
    }
  } finally {
    // ── Always close the dedicated window — NEVER touches user's tabs ─────
    if (jobWindow?.id) {
      await chrome.windows.remove(jobWindow.id).catch(() => {})
    }
    await chrome.storage.session.remove(['activeJob', 'tabId', 'jobResult']).catch(() => {})
  }
}

// ── Wait for content script to post a result ──────────────────────────────────
// Content scripts write { success, error?, confirmationText? } to
// chrome.storage.session under key 'jobResult'.

function waitForResult(
  tabId: number,
  timeout: number
): Promise<{ success: boolean; error?: string; confirmationText?: string }> {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      cleanup()
      resolve({ success: false, error: 'Timed out waiting for apply result' })
    }, timeout)

    function cleanup() {
      clearTimeout(deadline)
      chrome.storage.onChanged.removeListener(listener)
    }

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== 'session') return
      if (!changes.jobResult) return
      cleanup()
      resolve(changes.jobResult.newValue ?? { success: false, error: 'No result value' })
    }

    chrome.storage.onChanged.addListener(listener)
  })
}

// ── Message handlers (from popup / content scripts) ───────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'VERIFY_TOKEN') {
    verifyToken().then((ok) => sendResponse({ ok }))
    return true
  }

  if (msg.type === 'GET_ACTIVE_JOB') {
    chrome.storage.session.get('activeJob', (items) => sendResponse(items.activeJob ?? null))
    return true
  }

  if (msg.type === 'CLEAR_ACTIVE_JOB') {
    chrome.storage.session.remove('activeJob', () => sendResponse({ ok: true }))
    return true
  }

  if (msg.type === 'JOB_RESULT') {
    // Content script signals completion — write to session so waitForResult picks it up
    chrome.storage.session.set({ jobResult: msg.result }, () => sendResponse({ ok: true }))
    return true
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function showNotification(title: string, message: string) {
  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'assets/icon.png',
    title:   `Elite Apply — ${title}`,
    message,
  })
}

async function incrementBadge() {
  const { appliedCount = 0 } = await chrome.storage.local.get('appliedCount')
  const next = (appliedCount as number) + 1
  await chrome.storage.local.set({ appliedCount: next })
  chrome.action.setBadgeText({ text: String(next) })
  chrome.action.setBadgeBackgroundColor({ color: '#ea580c' })
}
