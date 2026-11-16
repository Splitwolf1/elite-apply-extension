import { useEffect, useState } from 'react'
import { getState, setState, type SubmitMode } from '~lib/storage'

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

  const open = (path: string) => chrome.tabs.create({ url: `${apiBase}${path}` })

  if (me === undefined) {
    return <div style={{ ...styles.container, padding: 24, textAlign: 'center', color: '#6b7280' }}>Checking…</div>
  }

  if (me === null) {
    return (
      <div style={styles.container}>
        <div style={styles.header}><span style={styles.logo}>⚡</span><span style={styles.title}>Elite Apply</span></div>
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
        <span style={styles.logo}>⚡</span>
        <span style={styles.title}>Elite Apply</span>
        <button onClick={toggle} title="When on, applies to jobs in your queue" style={{ ...styles.toggle, background: enabled ? '#ea580c' : '#d1d5db' }}>
          {enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={styles.body}>
        <button style={{ ...styles.btn, padding: '11px 0', fontSize: 14 }} onClick={autofillThisPage} disabled={filling}>
          {filling ? 'Filling…' : '⚡ Autofill this page'}
        </button>
        {fillMsg && <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: tone[fillMsg.tone] }}>{fillMsg.text}</p>}

        {resume && !resume.hasFile ? (
          <button onClick={() => open('/settings')} style={styles.notice}>⚠ No résumé uploaded — nothing gets attached. <u>Add one</u></button>
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
          <a href="#" onClick={(e) => { e.preventDefault(); open('/settings') }} style={styles.link}>Profile &amp; answers</a>
          <a href="#" onClick={(e) => { e.preventDefault(); open('/jobs/queue') }} style={styles.link}>Apply queue</a>
          <a href="#" onClick={(e) => { e.preventDefault(); signOut() }} style={{ ...styles.link, color: '#6b7280' }}>Sign out</a>
        </div>
        <p style={styles.hint}>{me.email ?? me.name} · {apiBase.replace(/^https?:\/\//, '')}</p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: 320, fontFamily: 'system-ui, sans-serif', fontSize: 13 },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: '#fff7ed', borderBottom: '1px solid #fed7aa' },
  logo: { fontSize: 20 },
  title: { flex: 1, fontWeight: 700, color: '#c2410c' },
  toggle: { border: 'none', borderRadius: 12, padding: '4px 12px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  body: { padding: 14, display: 'flex', flexDirection: 'column', gap: 9 },
  input: { border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 9px', fontSize: 13, outline: 'none' },
  btn: { background: '#ea580c', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 0', fontWeight: 600, cursor: 'pointer', fontSize: 13 },
  error: { color: '#dc2626', margin: '4px 0 0' },
  hint: { color: '#9ca3af', margin: 0, fontSize: 11 },
  link: { color: '#c2410c', textDecoration: 'none' },
  notice: { textAlign: 'left', fontSize: 12, padding: '7px 9px', borderRadius: 6, background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', cursor: 'pointer' },
}
