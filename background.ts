import type { PlasmoMessaging } from '@plasmohq/messaging'
import { getState, setState } from '~lib/storage'
import { verifyToken, fetchNextJob } from '~lib/api'

export {}

const ALARM_NAME = 'poll-queue'
const POLL_INTERVAL_MINUTES = 0.5 // every 30 seconds

// ── Startup ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES })
})

// ── Alarm handler — poll for pending jobs ────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return

  const { token, enabled } = await getState()
  if (!token || !enabled) return

  try {
    const job = await fetchNextJob()
    if (!job || !job.jobUrl) return  // nothing queued

    // Open the job URL in a new tab; the content script will handle it
    const tab = await chrome.tabs.create({ url: job.jobUrl, active: false })
    // Store the active job so content scripts can read it
    await setState({ lastError: null })
    await chrome.storage.session.set({ activeJob: job, tabId: tab.id })
  } catch (err: any) {
    await setState({ lastError: err.message })
  }
})

// ── Message handlers (from popup / content scripts) ──────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'VERIFY_TOKEN') {
    verifyToken().then((ok) => sendResponse({ ok }))
    return true  // keep channel open for async
  }

  if (msg.type === 'GET_ACTIVE_JOB') {
    chrome.storage.session.get('activeJob', (items) => sendResponse(items.activeJob ?? null))
    return true
  }

  if (msg.type === 'CLEAR_ACTIVE_JOB') {
    chrome.storage.session.remove('activeJob', () => sendResponse({ ok: true }))
    return true
  }
})
