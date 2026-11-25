import { useEffect, useState } from 'react'
import { getState, setState, type SubmitMode } from '~lib/storage'
import type { AtsSummary } from '~lib/api'

/**
 * Deliberately small: sign in, on/off, "Autofill this page", and status.
 * Everything the forms are filled from — profile, address, application
 * answers, résumés — lives in one place: Settings on the website.
 */

type FillResult =
  | { kind: 'filled'; filled: number; missing?: string[]; resumeUploaded?: boolean; resumeLabel?: string }
  | { kind: 'opening' | 'login' | 'iframe' | 'none' | 'error' }

function describe(r: FillResult | null | undefined): { text: string; tone: 'ok' | 'warn' | 'info' } {
  if (!r) return { text: 'Could not reach this page — reload it and try again.', tone: 'warn' }
  switch (r.kind) {
    case 'filled': {
      const attached = r.resumeUploaded ? ` and attached ${r.resumeLabel ? `“${r.resumeLabel}”` : 'your résumé'}` : ''
      const missing = r.missing?.length ? ` You still need to answer: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? '…' : ''}.` : ' Review it, then click Submit yourself.'
      return { text: `Filled ${r.filled} field${r.filled === 1 ? '' : 's'}${attached}.${missing}`, tone: r.missing?.length ? 'warn' : 'ok' }
    }
    case 'opening': return { text: 'Opening the application — it fills automatically as the form appears (sign in there if asked).', tone: 'info' }
    case 'login': return { text: 'Sign in or create your account on this site. It fills the application as soon as you’re in.', tone: 'info' }
    case 'iframe': return { text: 'Filling the application form on this page…', tone: 'info' }
    case 'none': return { text: 'No application form here. Open the job’s application page and try again.', tone: 'warn' }
    default: return { text: 'Something went wrong — reload the page and try again.', tone: 'warn' }
  }
}

export default function Popup() {
  const [enabled, setEnabled] = useState(false)
  const [submitMode, setSubmitMode] = useState<SubmitMode>('review')
  const [apiBase, setApiBase] = useState('')
  const [resume, setResume] = useState<{ hasFile: boolean; count?: number; labels?: string[] } | null>(null)
  // undefined = checking, null = signed out
  const [me, setMe] = useState<{ email: string | null; name: string | null } | null | undefined>(undefined)
  const [signingIn, setSigningIn] = useState(false)
  const [filling, setFilling] = useState(false)
  const [fillMsg, setFillMsg] = useState<{ text: string; tone: 'ok' | 'warn' | 'info' } | null>(null)
  const [manualKey, setManualKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [ats, setAts] = useState<AtsSummary | null>(null)
  const [atsErr, setAtsErr] = useState('')
  const [keyError, setKeyError] = useState('')

  const refresh = async () => {
    const s = await getState()
    setEnabled(s.enabled)
    setSubmitMode(s.submitMode)
    setApiBase(s.apiBase)
    if (!s.token) { setMe(null); setResume(null); return }
    const who = await chrome.runtime.sendMessage({ type: 'WHO_AM_I' }).catch(() => null)
    setMe(who ?? null)
    if (who) chrome.runtime.sendMessage({ type: 'RESUME_STATUS' }).then(setResume).catch(() => setResume(null))
  }

  useEffect(() => {
    refresh()
    // Sign-in happens in a website tab: pick it up whenever the key changes,
    // and re-check each time the popup regains focus.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'token' in changes) refresh()
    }
    const onFocus = () => refresh()
    chrome.storage.onChanged.addListener(onChange)
    window.addEventListener('focus', onFocus)
    return () => {
      chrome.storage.onChanged.removeListener(onChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const signIn = () => {
    setSigningIn(true)
    chrome.tabs.create({ url: `${apiBase}/extension/connect?from=extension` })
  }

  const signOut = async () => {
    await chrome.runtime.sendMessage({ type: 'SIGN_OUT' })
    setMe(null)
    setResume(null)
    setEnabled(false)
  }

  const useManualKey = async () => {
    setKeyError('')
    await setState({ token: manualKey.trim() })
    const res = await chrome.runtime.sendMessage({ type: 'VERIFY_TOKEN' })
    if (res?.ok) { setManualKey(''); refresh() }
    else { await setState({ token: null }); setKeyError('That key was not accepted.') }
  }

  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    await setState({ enabled: next })
  }

  const setAuto = async (auto: boolean) => {
    const mode: SubmitMode = auto ? 'auto' : 'review'
    setSubmitMode(mode)
    await setState({ submitMode: mode })
  }

  const autofillThisPage = async () => {
    setFilling(true)
    setFillMsg({ text: 'Working…', tone: 'info' })
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const res = await chrome.runtime.sendMessage({ type: 'AUTOFILL_TAB', tabId: tab?.id }).catch(() => null)
    setFillMsg(res?.ok ? describe(res.result) : { text: res?.error ?? 'Could not fill this page.', tone: 'warn' })
    setFilling(false)
  }

  const checkThisJob = async () => {
    setChecking(true); setAts(null); setAtsErr('')
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const page = tab?.id ? await chrome.tabs.sendMessage(tab.id, { type: 'EA_PAGE_TEXT' }).catch(() => null) : null
      if (!page?.text) { setAtsErr('Can’t read this page. Reload it and try again.'); return }
      const res = await chrome.runtime.sendMessage({ type: 'ATS_CHECK', jobText: `${page.title}\n${page.text}` }).catch(() => null)
      if (res?.ok) setAts(res.result)
      else setAtsErr(res?.error || 'The check didn’t finish. Try again.')
    } finally { setChecking(false) }
  }

  const open = (path: string) => chrome.tabs.create({ url: `${apiBase}${path}` })

  if (me === undefined) {
    return <div style={{ ...styles.container, padding: 24, textAlign: 'center', color: '#6b7280' }}>Checking…</div>
  }

  if (me === null) {
    return (
      <div style={styles.container}>
        <div style={styles.header}><span style={styles.logo} aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 11.5l3.5-3.5 2.5 2.5 5-6M10 4.5h3.5V8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span style={styles.title}>Elite Apply</span></div>
        <div style={styles.body}>
          <p style={{ margin: '2px 0 6px', color: '#374151' }}>Sign in to fill and track applications with your Elite Apply profile.</p>
          <button style={{ ...styles.btn, padding: '10px 0' }} onClick={signIn}>{signingIn ? 'Waiting for sign-in…' : 'Sign in'}</button>
          <details style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>Use a key instead</summary>
            <input style={{ ...styles.input, marginTop: 6, width: '100%', boxSizing: 'border-box' }} type="password" placeholder="Key from Settings → Extension"
              value={manualKey} onChange={(e) => setManualKey(e.target.value)} />
            <button style={{ ...styles.btn, marginTop: 6, width: '100%' }} onClick={useManualKey} disabled={!manualKey.trim()}>Connect</button>
            {keyError && <p style={styles.error}>{keyError}</p>}
          </details>
          <p style={styles.hint}>Server: {apiBase.replace(/^https?:\/\//, '')}</p>
        </div>
      </div>
    )
  }

  const tone = { ok: '#166534', warn: '#92400e', info: '#374151' }
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.logo} aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 11.5l3.5-3.5 2.5 2.5 5-6M10 4.5h3.5V8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
        <span style={styles.title}>Elite Apply</span>
        <button onClick={toggle} title="When on, applies to jobs in your queue" style={{ ...styles.toggle, background: enabled ? '#2f5bff' : '#cfd6e4' }}>
          {enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={styles.body}>
        <button style={{ ...styles.btn, padding: '11px 0', fontSize: 14 }} onClick={autofillThisPage} disabled={filling}>
          {filling ? 'Filling…' : 'Autofill this page'}
        </button>
        {fillMsg && <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: tone[fillMsg.tone] }}>{fillMsg.text}</p>}

        <button style={styles.btnLight} onClick={checkThisJob} disabled={checking}>{checking ? 'Checking this job…' : 'Check this job (ATS)'}</button>
        {atsErr && <p style={{ margin: 0, fontSize: 12, color: '#92400e' }}>{atsErr}</p>}
        {ats && (
          <div style={styles.atsBox}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ ...styles.ring, background: `conic-gradient(${ats.score >= 75 ? '#0c9f70' : ats.score >= 50 ? '#2f5bff' : '#e8513b'} ${ats.score}%, #eaf0ff 0)` }}>
                <b style={styles.ringInner}>{ats.score}</b>
              </span>
              <div style={{ fontSize: 12, lineHeight: 1.4, color: '#343b4c' }}>
                <b style={{ color: '#0b0d12' }}>{ats.have.length} of {ats.have.length + ats.missing.length} keywords</b><br />
                {ats.resumeLabel ? `vs “${ats.resumeLabel}”` : 'vs your résumé'}
                {ats.visa !== 'unknown' && <><br /><span style={{ color: ats.visa === 'sponsors' ? '#08734f' : '#b8321f' }}>{ats.visa === 'sponsors' ? 'Mentions sponsorship' : 'No sponsorship'}</span></>}
              </div>
            </div>
            {ats.missing.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#b8321f', width: '100%' }}>MISSING</span>
                {ats.missing.slice(0, 10).map((k) => <span key={k} style={styles.chipMiss}>{k}</span>)}
              </div>
            )}
            {ats.region && ats.region !== 'us' && <p style={{ margin: 0, fontSize: 11.5, color: '#4a5263' }}>Job is in {({ ca: 'Canada', uk: 'the UK / Ireland', eu: 'Europe' } as Record<string, string>)[ats.region]}: your {({ ca: 'Canadian', uk: 'UK', eu: 'European' } as Record<string, string>)[ats.region]} format is attached if you’ve created one.</p>}
            <a href="#" onClick={(e) => { e.preventDefault(); open('/ai-resume-scanner') }} style={styles.link}>Tailor a copy on the website →</a>
          </div>
        )}

        {resume && !resume.hasFile ? (
          <button onClick={() => open('/resumes/recent')} style={styles.notice}>No résumé uploaded, so nothing gets attached. <u>Add one</u></button>
        ) : resume?.hasFile ? (
          <div style={{ fontSize: 12, color: '#166534' }}>
            ✓ {resume.count && resume.count > 1 ? `${resume.count} résumés — the best fit is attached for each job` : `Attaching ${resume.labels?.[0] ?? 'your résumé'}`}
          </div>
        ) : null}

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={submitMode === 'auto'} onChange={(e) => setAuto(e.target.checked)} />
          Submit queued jobs automatically when nothing is missing
        </label>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderTop: '1px solid #f3f4f6', paddingTop: 8, marginTop: 2 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); open('/settings') }} style={styles.link}>Profile and answers</a>
          <a href="#" onClick={(e) => { e.preventDefault(); open('/jobs/queue') }} style={styles.link}>Apply queue</a>
          <a href="#" onClick={(e) => { e.preventDefault(); signOut() }} style={{ ...styles.link, color: '#6b7280' }}>Sign out</a>
        </div>
        <p style={styles.hint}>{me.email ?? me.name} · {apiBase.replace(/^https?:\/\//, '')}</p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: 330, fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: 13, color: '#0b0d12', background: '#fff' },
  header: { display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', background: '#fff', borderBottom: '1px solid #e3e8f2' },
  logo: { width: 24, height: 24, borderRadius: 7, background: '#0b0d12', display: 'grid', placeItems: 'center' },
  title: { flex: 1, fontWeight: 800, letterSpacing: '-0.02em', color: '#0b0d12', fontSize: 14.5 },
  toggle: { border: 'none', borderRadius: 999, padding: '4px 12px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 11.5 },
  body: { padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
  input: { border: '1px solid #cfd6e4', borderRadius: 9, padding: '8px 10px', fontSize: 13, outline: 'none' },
  btn: { background: '#0b0d12', color: '#fff', border: 'none', borderRadius: 10, padding: '9px 0', fontWeight: 600, cursor: 'pointer', fontSize: 13 },
  btnLight: { background: '#fff', color: '#0b0d12', border: '1px solid #cfd6e4', borderRadius: 10, padding: '9px 0', fontWeight: 600, cursor: 'pointer', fontSize: 13 },
  error: { color: '#b8321f', margin: '4px 0 0' },
  hint: { color: '#8a91a0', margin: 0, fontSize: 11 },
  link: { color: '#1c3fd6', textDecoration: 'none', fontWeight: 600 },
  notice: { textAlign: 'left', fontSize: 12, padding: '8px 10px', borderRadius: 10, background: '#fff4dc', border: '1px solid #ffd78a', color: '#7a4c00', cursor: 'pointer' },
  atsBox: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 14, background: 'linear-gradient(#f5f8ff, #e9efff)', boxShadow: 'inset 0 2px 1px rgba(255,255,255,.95), 0 10px 20px -16px rgba(47,91,255,.6)' },
  ring: { width: 50, height: 50, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none' },
  ringInner: { width: 38, height: 38, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', fontSize: 15 },
  chipMiss: { background: '#ffd0dc', color: '#7a1f35', borderRadius: 999, padding: '2px 8px', fontSize: 11.5, fontWeight: 600 },
}
