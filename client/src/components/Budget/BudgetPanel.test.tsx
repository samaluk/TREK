import { render, screen, waitFor, within } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../../tests/helpers/msw/server'
import { useAuthStore } from '../../store/authStore'
import { useTripStore } from '../../store/tripStore'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { buildTrip, buildUser } from '../../../tests/helpers/factories'
import type { BudgetTransaction } from '../../types'
import BudgetPanel from './BudgetPanel'

const members = [
  { id: 1, username: 'Alex' },
  { id: 2, username: 'Blair' },
]

const transaction = (overrides: Partial<BudgetTransaction> = {}): BudgetTransaction => ({
  id: 10,
  trip_id: 1,
  type: 'expense',
  title: 'Dinner',
  category: 'Food',
  transaction_date: '2026-05-10',
  note: 'Shared meal',
  currency: 'EUR',
  reservation_id: null,
  payers: [{ user_id: 1, username: 'Alex', amount: 120 }],
  splits: [
    { user_id: 1, username: 'Alex', amount: 60 },
    { user_id: 2, username: 'Blair', amount: 60 },
  ],
  ...overrides,
})

function mockLedger({
  transactions = [],
  budgets = [],
  settlement = { currencies: [] },
}: {
  transactions?: BudgetTransaction[]
  budgets?: unknown[]
  settlement?: unknown
} = {}) {
  server.use(
    http.get('/api/trips/1/budget/transactions', () => HttpResponse.json({ transactions })),
    http.get('/api/trips/1/budget/category-budgets', () => HttpResponse.json({ budgets })),
    http.get('/api/trips/1/budget/settlement', () => HttpResponse.json(settlement)),
  )
}

beforeEach(() => {
  resetAllStores()
  server.resetHandlers()
  seedStore(useAuthStore, { user: buildUser({ id: 1, role: 'admin' }), isAuthenticated: true })
  seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR' }) })
  mockLedger()
})

describe('BudgetPanel ledger workflow', () => {
  it('renders an empty ledger state', async () => {
    render(<BudgetPanel tripId={1} tripMembers={members} />)
    await screen.findByText('No budget transactions yet')
    expect(screen.getByText('Add an expense or settlement to start the ledger.')).toBeInTheDocument()
  })

  it('adds an expense with independent payer and split participants', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    const ledger: BudgetTransaction[] = []
    server.use(
      http.get('/api/trips/1/budget/transactions', () => HttpResponse.json({ transactions: ledger })),
      http.post('/api/trips/1/budget/transactions', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        const created = transaction({ id: 21, title: String(posted.title), category: String(posted.category) })
        ledger.push(created)
        return HttpResponse.json({ transaction: created })
      }),
    )

    render(<BudgetPanel tripId={1} tripMembers={members} />)
    await user.click(await screen.findByText('Add transaction'))
    await user.type(screen.getByLabelText('Title'), 'Museum tickets')
    await user.clear(screen.getByLabelText('Category'))
    await user.type(screen.getByLabelText('Category'), 'Activities')
    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '90')
    await user.click(screen.getAllByText('Alex')[1])
    await user.click(screen.getAllByText('Blair')[1])
    await user.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(posted?.title).toBe('Museum tickets')
      expect(posted?.payers).toEqual([{ user_id: 1, amount: 90 }])
      expect(posted?.splits).toEqual([{ user_id: 2, amount: 90 }])
    })
    await screen.findByText('Museum tickets')
  })

  it('adds a settlement transaction', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    const ledger: BudgetTransaction[] = []
    server.use(
      http.get('/api/trips/1/budget/transactions', () => HttpResponse.json({ transactions: ledger })),
      http.post('/api/trips/1/budget/transactions', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        const created = transaction({ id: 22, type: 'settlement', title: 'Blair paid Alex', category: 'Settlement' })
        ledger.push(created)
        return HttpResponse.json({ transaction: created })
      }),
    )

    render(<BudgetPanel tripId={1} tripMembers={members} />)
    await user.click(await screen.findByText('Add transaction'))
    await user.selectOptions(screen.getByLabelText('Type'), 'settlement')
    await user.clear(screen.getByLabelText('Title'))
    await user.type(screen.getByLabelText('Title'), 'Blair paid Alex')
    await user.clear(screen.getByLabelText('Category'))
    await user.type(screen.getByLabelText('Category'), 'Settlement')
    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '30')
    await user.click(screen.getAllByText('Alex')[0])
    await user.click(screen.getAllByText('Blair')[0])
    await user.click(screen.getByText('Save'))

    await waitFor(() => expect(posted?.type).toBe('settlement'))
    await screen.findByText('Blair paid Alex')
    expect(screen.getByText('settlement')).toBeInTheDocument()
  })

  it('edits and deletes a transaction', async () => {
    const user = userEvent.setup()
    mockLedger({ transactions: [transaction()] })
    server.use(
      http.put('/api/trips/1/budget/transactions/10', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>
        return HttpResponse.json({ transaction: transaction({ title: String(body.title) }) })
      }),
      http.delete('/api/trips/1/budget/transactions/10', () => HttpResponse.json({ success: true })),
    )

    render(<BudgetPanel tripId={1} tripMembers={members} />)
    await screen.findByText('Dinner')
    await user.click(screen.getByTitle('Edit'))
    await user.clear(screen.getByLabelText('Title'))
    await user.type(screen.getByLabelText('Title'), 'Tapas')
    const saveButtons = screen.getAllByText('Save')
    await user.click(saveButtons[saveButtons.length - 1])
    await screen.findByText('Tapas')

    await user.click(screen.getByTitle('Delete'))
    await waitFor(() => expect(screen.queryByText('Tapas')).not.toBeInTheDocument())
  })

  it('displays multi-currency settlement and category budget progress', async () => {
    mockLedger({
      transactions: [
        transaction(),
        transaction({ id: 11, title: 'Taxi', category: 'Transport', currency: 'USD', payers: [{ user_id: 2, username: 'Blair', amount: 40 }], splits: [{ user_id: 1, username: 'Alex', amount: 40 }] }),
      ],
      budgets: [
        { trip_id: 1, category: 'Food', currency: 'EUR', amount: 200, spent: 120, remaining: 80 },
        { trip_id: 1, category: 'Transport', currency: 'USD', amount: 100, spent: 40, remaining: 60 },
      ],
      settlement: {
        currencies: [
          { currency: 'EUR', balances: [], flows: [{ from: { user_id: 2, username: 'Blair' }, to: { user_id: 1, username: 'Alex' }, amount: 60 }] },
          { currency: 'USD', balances: [], flows: [{ from: { user_id: 1, username: 'Alex' }, to: { user_id: 2, username: 'Blair' }, amount: 40 }] },
        ],
      },
    })

    render(<BudgetPanel tripId={1} tripMembers={members} />)
    await screen.findByText('Dinner')
    await screen.findByText('Taxi')
    const settlement = screen.getByText('Settlement').closest('section')!
    expect(within(settlement).getByText('EUR')).toBeInTheDocument()
    expect(within(settlement).getByText('USD')).toBeInTheDocument()
    expect(screen.getByText(/120.00 EUR spent, 80.00 EUR left/)).toBeInTheDocument()
    expect(screen.getByText(/40.00 USD spent, 60.00 USD left/)).toBeInTheDocument()
  })
})
