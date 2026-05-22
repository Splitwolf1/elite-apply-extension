import type { PlasmoCSConfig } from 'plasmo'
import { getState } from '~lib/storage'
import { getAnswer, getResume } from '~lib/api'

export const config: PlasmoCSConfig = {
  matches: ['https://www.linkedin.com/jobs/*'],
  run_at: 'document_idle',
}

// Wait for an element matching `selector` to appear, up to `timeoutMs`
function waitFor(selector: string, timeoutMs = 10_000): Promise<Element | null> {
  return new Promise((resolve) => {
    const el = document.querySelector(selector)
    if (el) return resolve(el)

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector)
      if (found) { observer.disconnect(); resolve(found) }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => { observer.disconnect(); resolve(null) }, timeoutMs)
  })
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.focus()
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function fillLinkedInEasyApply(job: { queueId: string; jobUrl: string; profile: any }) {
  const { profile } = job
  const modal = await waitFor('.jobs-easy-apply-modal')
  if (!modal) return { success: false, error: 'Easy Apply modal not found' }

  let page = 0
  const MAX_PAGES = 15

  while (page++ < MAX_PAGES) {
    // Fill all visible text / email / tel inputs
    const inputs = modal.querySelectorAll<HTMLInputElement>('input[type=text],input[type=email],input[type=tel],textarea')
    for (const input of inputs) {
      const label = (input.labels?.[0]?.textContent ?? input.placeholder ?? '').toLowerCase()
      if (input.value) continue  // already filled

      if (label.includes('first')) await typeInto(input, profile.firstName)
      else if (label.includes('last')) await typeInto(input, profile.lastName)
      else if (label.includes('email')) await typeInto(input, profile.email)
      else if (label.includes('phone')) await typeInto(input, profile.phone)
      else if (label.includes('linkedin')) await typeInto(input, profile.linkedinUrl ?? '')
      else if (label.includes('website') || label.includes('portfolio')) await typeInto(input, profile.portfolioUrl ?? '')
      else {
        // Unknown field — ask AI for answer
        const answer = await getAnswer(label, JSON.stringify(profile)).catch(() => '')
        if (answer) await typeInto(input, answer)
      }
    }

    // Handle file upload (resume)
    const fileInput = modal.querySelector<HTMLInputElement>('input[type=file]')
    if (fileInput && profile.resumeLocalPath) {
      // Extension cannot directly set file input value; trigger click to allow user
      // For automated flow, we rely on resume URL cached on server
      const resumeData = await getResume().catch(() => null)
      if (resumeData?.url) {
        // Fetch blob and dispatch via DataTransfer
        try {
          const blob = await fetch(resumeData.url).then(r => r.blob())
          const file = new File([blob], 'resume.pdf', { type: 'application/pdf' })
          const dt = new DataTransfer()
          dt.items.add(file)
          fileInput.files = dt.files
          fileInput.dispatchEvent(new Event('change', { bubbles: true }))
        } catch { /* skip */ }
      }
    }

    // Check for work authorization radio buttons
    const radios = modal.querySelectorAll<HTMLInputElement>('input[type=radio]')
    for (const radio of radios) {
      const labelText = (radio.labels?.[0]?.textContent ?? '').toLowerCase()
      if ((labelText.includes('authorized') || labelText.includes('legal')) && labelText.includes('yes')) {
        radio.click()
      }
      if (labelText.includes('sponsor') && labelText.includes('no')) {
        radio.click()
      }
    }

    // Try "Next" or "Review" button
    const nextBtn = modal.querySelector<HTMLButtonElement>('button[aria-label="Continue to next step"]')
    const reviewBtn = modal.querySelector<HTMLButtonElement>('button[aria-label="Review your application"]')
    const submitBtn = modal.querySelector<HTMLButtonElement>('button[aria-label="Submit application"]')

    if (submitBtn) {
      submitBtn.click()
      await new Promise(r => setTimeout(r, 2000))
      return { success: true, confirmationText: 'Application submitted via LinkedIn Easy Apply' }
    }

    if (reviewBtn) {
      reviewBtn.click()
      await new Promise(r => setTimeout(r, 1500))
      continue
    }

    if (nextBtn) {
      nextBtn.click()
      await new Promise(r => setTimeout(r, 1500))
      continue
    }

    break
  }

  return { success: false, error: 'Could not complete LinkedIn Easy Apply flow' }
}

// ── Entry point ───────────────────────────────────────────────────────────────

;(async () => {
  const { enabled } = await getState()
  if (!enabled) return

  // Get active job from background
  const job = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_JOB' })
  if (!job || !job.jobUrl.includes('linkedin.com')) return

  // Click the Easy Apply button if present
  const easyApplyBtn = await waitFor('button.jobs-apply-button')
  if (!easyApplyBtn) return
  ;(easyApplyBtn as HTMLButtonElement).click()
  await new Promise(r => setTimeout(r, 1500))

  const result = await fillLinkedInEasyApply(job).catch((err) => ({
    success: false as const,
    error: err.message as string,
    confirmationText: undefined as string | undefined,
  }))

  // Signal background — it owns reporting, notification, and window cleanup
  chrome.runtime.sendMessage({ type: 'JOB_RESULT', result })
})()
