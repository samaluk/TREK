import { useEffect, useMemo, useState } from 'react'
import { Calculator, Download, Pencil, Plus, Save, Trash2, Wallet, X } from 'lucide-react'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTranslation } from '../../i18n'
import type { BudgetTransaction, BudgetTransactionType } from '../../types'
import { currencyDecimals } from '../../utils/formatters'

interface TripMember {
  id: number
  username: string
  avatar_url?: string | null
}

interface BudgetPanelProps {
  tripId: number | string
  tripMembers?: TripMember[]
}

const CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'BRL', 'MXN', 'CLP', 'ARS']
const TYPES: BudgetTransactionType[] = ['expense', 'settlement', 'adjustment']

const emptyForm = (currency: string, userId?: number) => ({
  type: 'expense' as BudgetTransactionType,
  title: '',
  category: 'Other',
  transaction_date: new Date().toISOString().slice(0, 10),
  currency,
  amount: '0',
  note: '',
  payerIds: userId ? [userId] : [] as number[],
  splitIds: userId ? [userId] : [] as number[],
})

function money(value: number, currency: string, locale: string) {
  const decimals = currencyDecimals(currency)
  return `${Number(value || 0).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${currency}`
}

function partyNames(transaction: BudgetTransaction, key: 'payers' | 'splits', members: TripMember[]) {
  return transaction[key].map(party => party.username || members.find(m => m.id === party.user_id)?.username || `#${party.user_id}`).join(', ')
}

function transactionTotal(transaction: BudgetTransaction) {
  return transaction.payers.reduce((sum, payer) => sum + Number(payer.amount || 0), 0)
}

function splitAmount(total: number, ids: number[]) {
  if (ids.length === 0) return []
  const share = Math.round((total / ids.length) * 100) / 100
  return ids.map(user_id => ({ user_id, amount: share }))
}

function MemberCheckboxes({ members, selected, onChange }: { members: TripMember[]; selected: number[]; onChange: (ids: number[]) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {members.map(member => {
        const active = selected.includes(member.id)
        return (
          <button key={member.id} type="button" onClick={() => onChange(active ? selected.filter(id => id !== member.id) : [...selected, member.id])}
            style={{
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border-primary)'}`,
              background: active ? 'var(--accent)' : 'var(--bg-card)',
              color: active ? 'var(--accent-text)' : 'var(--text-primary)',
              borderRadius: 999, padding: '6px 10px', fontSize: 12, cursor: 'pointer',
            }}>
            {member.username}
          </button>
        )
      })}
    </div>
  )
}

export default function BudgetPanel({ tripId, tripMembers = [] }: BudgetPanelProps) {
  const {
    trip,
    budgetTransactions,
    budgetCategoryBudgets,
    budgetSettlement,
    loadBudgetLedger,
    addBudgetTransaction,
    updateBudgetTransaction,
    deleteBudgetTransaction,
    replaceBudgetCategoryBudgets,
  } = useTripStore()
  const can = useCanDo()
  const { locale } = useTranslation()
  const currency = trip?.currency || 'EUR'
  const canEdit = can('budget_edit', trip)
  const members = tripMembers.length > 0 ? tripMembers : []
  const defaultUserId = members[0]?.id

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<BudgetTransaction | null>(null)
  const [form, setForm] = useState(emptyForm(currency, defaultUserId))
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({})

  useEffect(() => { loadBudgetLedger(tripId) }, [tripId, loadBudgetLedger])

  useEffect(() => {
    const draft: Record<string, string> = {}
    for (const budget of budgetCategoryBudgets) draft[`${budget.category}\0${budget.currency}`] = String(budget.amount)
    setBudgetDraft(draft)
  }, [budgetCategoryBudgets])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const transaction of budgetTransactions) if (transaction.category) set.add(transaction.category)
    for (const budget of budgetCategoryBudgets) set.add(budget.category)
    set.add('Other')
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [budgetTransactions, budgetCategoryBudgets])

  const grouped = useMemo(() => {
    const map = new Map<string, BudgetTransaction[]>()
    for (const transaction of budgetTransactions) {
      const key = transaction.transaction_date || 'Undated'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(transaction)
    }
    return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [budgetTransactions])

  const totalsByCurrency = useMemo(() => {
    const totals = new Map<string, number>()
    for (const transaction of budgetTransactions) {
      if (transaction.type === 'settlement') continue
      totals.set(transaction.currency, (totals.get(transaction.currency) || 0) + transactionTotal(transaction))
    }
    return Array.from(totals.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [budgetTransactions])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm(currency, defaultUserId))
    setFormOpen(true)
  }

  const openEdit = (transaction: BudgetTransaction) => {
    setEditing(transaction)
    setForm({
      type: transaction.type,
      title: transaction.title,
      category: transaction.category || 'Other',
      transaction_date: transaction.transaction_date,
      currency: transaction.currency,
      amount: String(transactionTotal(transaction)),
      note: transaction.note || '',
      payerIds: transaction.payers.map(p => p.user_id),
      splitIds: transaction.splits.map(s => s.user_id),
    })
    setFormOpen(true)
  }

  const submit = async () => {
    const amount = Number(String(form.amount).replace(',', '.')) || 0
    const payload = {
      type: form.type,
      title: form.title.trim(),
      category: form.category.trim() || null,
      transaction_date: form.transaction_date,
      currency: form.currency,
      note: form.note.trim() || null,
      payers: splitAmount(amount, form.payerIds),
      splits: splitAmount(amount, form.splitIds),
    }
    if (!payload.title || payload.payers.length === 0 || payload.splits.length === 0) return
    if (editing) await updateBudgetTransaction(tripId, editing.id, payload)
    else await addBudgetTransaction(tripId, payload)
    setFormOpen(false)
  }

  const saveBudgets = async () => {
    const budgets = Object.entries(budgetDraft)
      .map(([key, amount]) => {
        const [category, cur] = key.split('\0')
        return { category, currency: cur, amount: Number(String(amount).replace(',', '.')) || 0 }
      })
      .filter(row => row.category)
    await replaceBudgetCategoryBudgets(tripId, budgets)
  }

  const addBudgetCap = () => {
    const category = categories[0] || 'Other'
    setBudgetDraft(current => ({ ...current, [`${category}\0${currency}`]: current[`${category}\0${currency}`] || '0' }))
  }

  const exportCsv = () => {
    const rows = [['Type', 'Title', 'Category', 'Date', 'Currency', 'Amount', 'Payers', 'Splits', 'Note']]
    for (const transaction of budgetTransactions) {
      rows.push([
        transaction.type,
        transaction.title,
        transaction.category || '',
        transaction.transaction_date,
        transaction.currency,
        String(transactionTotal(transaction)),
        partyNames(transaction, 'payers', members),
        partyNames(transaction, 'splits', members),
        transaction.note || '',
      ])
    }
    const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\r\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `budget-ledger-${trip?.title || tripId}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Budget</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Transactions, settlements, and category budgets</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={exportCsv} title="Export CSV" style={buttonStyle('secondary')}><Download size={16} /> CSV</button>
          {canEdit && <button onClick={openCreate} style={buttonStyle('primary')}><Plus size={16} /> Transaction</button>}
        </div>
      </div>

      {budgetTransactions.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', border: '1px dashed var(--border-primary)', borderRadius: 12 }}>
          <Calculator size={32} color="var(--text-muted)" />
          <h3 style={{ color: 'var(--text-primary)' }}>No budget transactions yet</h3>
          <p style={{ color: 'var(--text-muted)' }}>Add an expense or settlement to start the ledger.</p>
          {canEdit && <button onClick={openCreate} style={buttonStyle('primary')}><Plus size={16} /> Add transaction</button>}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 18, alignItems: 'start' }} className="max-lg:!grid-cols-1">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {grouped.map(([date, transactions]) => (
              <section key={date} style={panelStyle}>
                <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-primary)', fontWeight: 700, color: 'var(--text-primary)' }}>{date}</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
                    <thead>
                      <tr>
                        {['Type', 'Title', 'Category', 'Amount', 'Payers', 'Splits', 'Note', ''].map(h => <th key={h} style={thStyle}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map(transaction => (
                        <tr key={transaction.id}>
                          <td style={tdStyle}><span style={pillStyle(transaction.type)}>{transaction.type}</span></td>
                          <td style={tdStyle}>{transaction.title}</td>
                          <td style={tdStyle}>{transaction.category || '-'}</td>
                          <td style={tdStyle}>{money(transactionTotal(transaction), transaction.currency, locale)}</td>
                          <td style={tdStyle}>{partyNames(transaction, 'payers', members) || '-'}</td>
                          <td style={tdStyle}>{partyNames(transaction, 'splits', members) || '-'}</td>
                          <td style={tdStyle}>{transaction.note || '-'}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>
                            {canEdit && (
                              <div style={{ display: 'inline-flex', gap: 4 }}>
                                <button onClick={() => openEdit(transaction)} title="Edit" style={iconButtonStyle}><Pencil size={14} /></button>
                                <button onClick={() => deleteBudgetTransaction(tripId, transaction.id)} title="Delete" style={iconButtonStyle}><Trash2 size={14} /></button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <section style={panelStyle}>
              <div style={cardHeaderStyle}><Wallet size={18} /> Totals</div>
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {totalsByCurrency.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>No expense totals</span> : totalsByCurrency.map(([cur, total]) => (
                  <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--text-primary)' }}>
                    <span>{cur}</span><span>{money(total, cur, locale)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section style={panelStyle}>
              <div style={cardHeaderStyle}>Settlement</div>
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {budgetSettlement?.currencies?.some(c => c.flows.length > 0) ? budgetSettlement.currencies.map(currencySummary => (
                  <div key={currencySummary.currency}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{currencySummary.currency}</div>
                    {currencySummary.flows.map((flow, index) => (
                      <div key={index} style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        {flow.from.username} pays {flow.to.username} {money(flow.amount, currencySummary.currency, locale)}
                      </div>
                    ))}
                  </div>
                )) : <span style={{ color: 'var(--text-muted)' }}>No open settlement flows</span>}
              </div>
            </section>

            <section style={panelStyle}>
              <div style={cardHeaderStyle}>Category budgets</div>
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(budgetDraft).map(([key, value]) => {
                  const [category, cur] = key.split('\0')
                  const progress = budgetCategoryBudgets.find(b => b.category === category && b.currency === cur)
                  return (
                    <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 8, alignItems: 'center' }}>
                      <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>
                        <strong>{category}</strong> <span style={{ color: 'var(--text-muted)' }}>{cur}</span>
                        {progress && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{money(progress.spent, cur, locale)} spent, {money(progress.remaining, cur, locale)} left</div>}
                      </div>
                      <input value={value} onChange={e => setBudgetDraft(d => ({ ...d, [key]: e.target.value }))} disabled={!canEdit} style={inputStyle} />
                    </div>
                  )
                })}
                {canEdit && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={addBudgetCap} style={buttonStyle('secondary')}><Plus size={14} /> Cap</button>
                    <button onClick={saveBudgets} style={buttonStyle('primary')}><Save size={14} /> Save</button>
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>
      )}

      {formOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: 'min(680px, 100%)', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottom: '1px solid var(--border-primary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{editing ? 'Edit transaction' : 'Add transaction'}</strong>
              <button onClick={() => setFormOpen(false)} style={iconButtonStyle}><X size={16} /></button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12 }}>
              <div style={formGridStyle}>
                <label style={labelStyle}>Type<select value={form.type} onChange={e => setForm({ ...form, type: e.target.value as BudgetTransactionType })} style={inputStyle}>{TYPES.map(type => <option key={type}>{type}</option>)}</select></label>
                <label style={labelStyle}>Date<input type="date" value={form.transaction_date} onChange={e => setForm({ ...form, transaction_date: e.target.value })} style={inputStyle} /></label>
                <label style={labelStyle}>Currency<select value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })} style={inputStyle}>{CURRENCIES.map(cur => <option key={cur}>{cur}</option>)}</select></label>
                <label style={labelStyle}>Amount<input value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} inputMode="decimal" style={inputStyle} /></label>
              </div>
              <label style={labelStyle}>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} style={inputStyle} /></label>
              <label style={labelStyle}>Category<input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} list="budget-categories" style={inputStyle} /></label>
              <datalist id="budget-categories">{categories.map(category => <option key={category} value={category} />)}</datalist>
              <label style={labelStyle}>Payers<MemberCheckboxes members={members} selected={form.payerIds} onChange={ids => setForm({ ...form, payerIds: ids })} /></label>
              <label style={labelStyle}>Split participants<MemberCheckboxes members={members} selected={form.splitIds} onChange={ids => setForm({ ...form, splitIds: ids })} /></label>
              <label style={labelStyle}>Note<textarea value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} style={{ ...inputStyle, minHeight: 72 }} /></label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 16, borderTop: '1px solid var(--border-primary)' }}>
              <button onClick={() => setFormOpen(false)} style={buttonStyle('secondary')}>Cancel</button>
              <button onClick={submit} style={buttonStyle('primary')}><Save size={16} /> Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const panelStyle = { background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10, overflow: 'hidden' }
const thStyle = { padding: '9px 10px', textAlign: 'left' as const, fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)', textTransform: 'uppercase' as const }
const tdStyle = { padding: '10px', borderBottom: '1px solid var(--border-secondary)', color: 'var(--text-primary)', fontSize: 13, verticalAlign: 'top' as const }
const cardHeaderStyle = { padding: '12px 14px', borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: 'var(--text-primary)' }
const inputStyle = { width: '100%', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg-input)', color: 'var(--text-primary)', font: 'inherit' }
const labelStyle = { display: 'flex', flexDirection: 'column' as const, gap: 6, color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }
const formGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }
const iconButtonStyle = { border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }
const buttonStyle = (kind: 'primary' | 'secondary') => ({
  border: kind === 'primary' ? 'none' : '1px solid var(--border-primary)',
  background: kind === 'primary' ? 'var(--accent)' : 'var(--bg-card)',
  color: kind === 'primary' ? 'var(--accent-text)' : 'var(--text-primary)',
  borderRadius: 8,
  padding: '8px 12px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontWeight: 600,
})
const pillStyle = (type: BudgetTransactionType) => ({
  borderRadius: 999,
  padding: '4px 8px',
  fontSize: 11,
  fontWeight: 700,
  color: type === 'settlement' ? '#0369a1' : type === 'adjustment' ? '#a16207' : '#047857',
  background: type === 'settlement' ? '#e0f2fe' : type === 'adjustment' ? '#fef3c7' : '#d1fae5',
})
