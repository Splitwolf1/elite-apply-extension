import { useEffect, useState } from 'react'
import { DEFAULT_SCREENING, getState, setState, type ScreeningAnswers, type SubmitMode } from '~lib/storage'

type TriState = 'unset' | 'yes' | 'no'
const toTri = (v: boolean | null): TriState => (v === null ? 'unset' : v ? 'yes' : 'no')
const fromTri = (v: TriState): boolean | null => (v === 'unset' ? null : v === 'yes')

export default function Popup() {
  const [token, setToken] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [submitMode, setSubmitMode] = useState<SubmitMode>('review')
  const [screening, setScreening] = useState<ScreeningAnswers>(DEFAULT_SCREENING)
  const [status, setStatus] = useState<'idle' | 'verifying' | 'ok' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getState().then((s) => {
      setToken(s.token ?? '')
      setEnabled(s.enabled)
      setSubmitMode(s.submitMode)
      setScreening(s.screening)
    })
  }, [])

  const handleSave = async () => {
    setStatus('verifying')
    setErrorMsg('')
    await setState({ token: token.trim() })
    const res = await chrome.runtime.sendMessage({ type: 'VERIFY_TOKEN' })
    if (res?.ok) setStatus('ok')
    else {
      setStatus('error')
      setErrorMsg('Token invalid or server unreachable.')
    }
  }

  const handleToggle = async () => {
    const next = !enabled
    setEnabled(next)
    await setState({ enabled: next })
  }

  const updateScreening = async (patch: Partial<ScreeningAnswers>) => {
    const next = { ...screening, ...patch }
    setScreening(next)
    await setState({ screening: next })
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const updateMode = async (mode: SubmitMode) => {
    setSubmitMode(mode)
    await setState({ submitMode: mode })
  }

  const [fillMsg, setFillMsg] = useState('')
  const autofillThisPage = async () => {
    setFillMsg('Filling…')
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const res = await chrome.runtime.sendMessage({ type: 'AUTOFILL_TAB', tabId: tab?.id })
    setFillMsg(res?.ok ? 'Done — check the form, then click Submit yourself.' : res?.error ?? 'Could not fill this page.')
  }

  const legalUnset = screening.workAuthorized === null || screening.needsSponsorship === null

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.logo}>⚡</span>
        <span style={styles.title}>Elite Apply</span>
        <button onClick={handleToggle} style={{ ...styles.toggle, background: enabled ? '#ea580c' : '#d1d5db' }}>
          {enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={styles.body}>
        <button style={{ ...styles.btn, padding: '10px 0' }} onClick={autofillThisPage} disabled={status !== 'ok' && !token}>
          ⚡ Autofill this page
        </button>
        {fillMsg && <p style={styles.hint}>{fillMsg}</p>}

        <label style={{ ...styles.label, marginTop: 8 }}>API Token</label>
        <input
          style={styles.input}
          type="password"
          placeholder="Paste token from Settings → Extension"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button style={styles.btn} onClick={handleSave} disabled={status === 'verifying'}>
          {status === 'verifying' ? 'Checking…' : 'Save & Verify'}
        </button>
        {status === 'ok' && <p style={styles.success}>Connected!</p>}
        {status === 'error' && <p style={styles.error}>{errorMsg}</p>}

        <div style={styles.section}>Submitting</div>
        <label style={styles.radio}>
          <input type="radio" checked={submitMode === 'review'} onChange={() => updateMode('review')} />
          <span><b>Review before submit</b> (recommended) — we fill it, you click Submit</span>
        </label>
        <label style={styles.radio}>
          <input type="radio" checked={submitMode === 'auto'} onChange={() => updateMode('auto')} />
          <span><b>Fully automatic</b> — submit when every required answer is filled</span>
        </label>

        <div style={styles.section}>Screening answers {saved && <span style={styles.saved}>saved</span>}</div>
        {legalUnset && (
          <p style={styles.warn}>Set these two — forms that ask them will wait for you until you do.</p>
        )}
        <Tri label="Authorized to work in the job's country?" value={toTri(screening.workAuthorized)}
          onChange={(v) => updateScreening({ workAuthorized: fromTri(v) })} />
        <Tri label="Need visa sponsorship (now or later)?" value={toTri(screening.needsSponsorship)}
          onChange={(v) => updateScreening({ needsSponsorship: fromTri(v) })} />
        <Tri label="Willing to relocate?" value={toTri(screening.willingToRelocate)}
          onChange={(v) => updateScreening({ willingToRelocate: fromTri(v) })} />
        <Text label="Salary expectation" value={screening.salaryExpectation} placeholder="e.g. 120000"
          onChange={(v) => updateScreening({ salaryExpectation: v })} />
        <Text label="Notice period" value={screening.noticePeriod} placeholder="e.g. 2 weeks"
          onChange={(v) => updateScreening({ noticePeriod: v })} />
        <Text label="How did you hear about us?" value={screening.howDidYouHear} placeholder="LinkedIn"
          onChange={(v) => updateScreening({ howDidYouHear: v })} />
        <p style={styles.hint}>
          Voluntary self-identification (gender, race, veteran, disability) is always answered “prefer not to say”.
          We never enter passwords, create accounts, solve CAPTCHAs or tick consent boxes for you.
        </p>
      </div>
    </div>
  )
}

function Tri({ label, value, onChange }: { label: string; value: TriState; onChange: (v: TriState) => void }) {
  return (
    <label style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <select style={styles.select} value={value} onChange={(e) => onChange(e.target.value as TriState)}>
        <option value="unset">Ask me</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  )
}

function Text({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <label style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <input style={{ ...styles.input, width: 120 }} value={v} placeholder={placeholder}
        onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v.trim())} />
    </label>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { width: 340, fontFamily: 'system-ui, sans-serif', fontSize: 13 },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '12px 16px', background: '#fff7ed', borderBottom: '1px solid #fed7aa',
  },
  logo: { fontSize: 20 },
  title: { flex: 1, fontWeight: 700, color: '#c2410c' },
  toggle: { border: 'none', borderRadius: 12, padding: '4px 12px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  body: { padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontWeight: 600, color: '#374151' },
  input: { border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 9px', fontSize: 13, outline: 'none' },
  btn: { background: '#ea580c', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 0', fontWeight: 600, cursor: 'pointer', fontSize: 13 },
  success: { color: '#15803d', margin: 0 },
  error: { color: '#dc2626', margin: 0 },
  warn: { color: '#b45309', background: '#fffbeb', borderRadius: 6, padding: '6px 8px', margin: 0 },
  hint: { color: '#6b7280', margin: '4px 0 0', lineHeight: 1.45, fontSize: 12 },
  section: { marginTop: 10, fontWeight: 700, color: '#111827', borderTop: '1px solid #f3f4f6', paddingTop: 10 },
  saved: { color: '#15803d', fontWeight: 500, fontSize: 11, marginLeft: 6 },
  radio: { display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.4, color: '#374151', cursor: 'pointer' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowLabel: { color: '#374151', flex: 1 },
  select: { border: '1px solid #d1d5db', borderRadius: 6, padding: '5px 6px', fontSize: 12 },
}
