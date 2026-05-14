// FE-STORE-BUDGET-001 to FE-STORE-BUDGET-011
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildBudgetItem } from '../../../tests/helpers/factories';
import { useTripStore } from '../tripStore';

beforeEach(() => {
  resetAllStores();
  server.resetHandlers();
});

describe('budgetSlice', () => {
  it('FE-STORE-BUDGET-001: loadBudgetItems populates store', async () => {
    const item = buildBudgetItem({ trip_id: 1 });
    server.use(
      http.get('/api/trips/1/budget', () =>
        HttpResponse.json({ items: [item] })
      )
    );
    await useTripStore.getState().loadBudgetItems(1);
    expect(useTripStore.getState().budgetItems).toHaveLength(1);
    expect(useTripStore.getState().budgetItems[0].id).toBe(item.id);
  });

  it('FE-STORE-BUDGET-002: loadBudgetItems swallows errors silently', async () => {
    server.use(
      http.get('/api/trips/1/budget', () =>
        HttpResponse.json({ error: 'server error' }, { status: 500 })
      )
    );
    // Should NOT throw
    await expect(useTripStore.getState().loadBudgetItems(1)).resolves.toBeUndefined();
    expect(useTripStore.getState().budgetItems).toEqual([]);
  });

  it('FE-STORE-BUDGET-003: addBudgetItem appends to store and returns item', async () => {
    const newItem = buildBudgetItem({ name: 'Hotel', trip_id: 1 });
    server.use(
      http.post('/api/trips/1/budget', () =>
        HttpResponse.json({ item: newItem })
      )
    );
    const result = await useTripStore.getState().addBudgetItem(1, { name: 'Hotel' });
    expect(result.id).toBe(newItem.id);
    expect(useTripStore.getState().budgetItems).toContainEqual(newItem);
  });

  it('FE-STORE-BUDGET-004: addBudgetItem throws on API error', async () => {
    server.use(
      http.post('/api/trips/1/budget', () =>
        HttpResponse.json({ error: 'Validation failed' }, { status: 422 })
      )
    );
    await expect(useTripStore.getState().addBudgetItem(1, {})).rejects.toThrow();
  });

  it('FE-STORE-BUDGET-005: updateBudgetItem replaces item in store', async () => {
    const existing = buildBudgetItem({ id: 10, trip_id: 1, name: 'Old' });
    seedStore(useTripStore, { budgetItems: [existing] });

    const updated = { ...existing, name: 'New' };
    server.use(
      http.put('/api/trips/1/budget/10', () =>
        HttpResponse.json({ item: updated })
      )
    );
    await useTripStore.getState().updateBudgetItem(1, 10, { name: 'New' });
    const items = useTripStore.getState().budgetItems;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('New');
  });

  it('FE-STORE-BUDGET-006: updateBudgetItem calls loadReservations when reservation_id + total_price provided', async () => {
    const existing = buildBudgetItem({ id: 20, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [existing] });

    const loadReservations = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, { loadReservations });

    const itemWithReservation = { ...existing, reservation_id: 99 };
    server.use(
      http.put('/api/trips/1/budget/20', () =>
        HttpResponse.json({ item: itemWithReservation })
      )
    );
    await useTripStore.getState().updateBudgetItem(1, 20, { total_price: 50 });
    expect(loadReservations).toHaveBeenCalledWith(1);
  });

  it('FE-STORE-BUDGET-007: deleteBudgetItem optimistically removes and rolls back on error', async () => {
    const item = buildBudgetItem({ id: 5, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [item] });

    server.use(
      http.delete('/api/trips/1/budget/5', () =>
        HttpResponse.json({ error: 'forbidden' }, { status: 403 })
      )
    );
    // The item is removed immediately (optimistic), then restored on error
    const deletePromise = useTripStore.getState().deleteBudgetItem(1, 5);
    await expect(deletePromise).rejects.toThrow();
    // After rollback, item is back
    expect(useTripStore.getState().budgetItems).toContainEqual(item);
  });

  it('FE-STORE-BUDGET-008: setBudgetItemMembers updates members on matching item', async () => {
    const item = buildBudgetItem({ id: 7, trip_id: 1, members: [] });
    seedStore(useTripStore, { budgetItems: [item] });

    const members = [{ user_id: 1, paid: false }, { user_id: 2, paid: false }];
    const updatedItem = { ...item, persons: 2, members };
    server.use(
      http.put('/api/trips/1/budget/7/members', () =>
        HttpResponse.json({ members, item: updatedItem })
      )
    );
    await useTripStore.getState().setBudgetItemMembers(1, 7, [1, 2]);
    const stored = useTripStore.getState().budgetItems.find(i => i.id === 7);
    expect(stored?.members).toHaveLength(2);
    expect(stored?.persons).toBe(2);
  });

  it('FE-STORE-BUDGET-009: toggleBudgetMemberPaid updates paid flag on matching member', async () => {
    const item = buildBudgetItem({
      id: 8,
      trip_id: 1,
      members: [{ user_id: 3, paid: false }],
    });
    seedStore(useTripStore, { budgetItems: [item] });

    server.use(
      http.put('/api/trips/1/budget/8/members/3/paid', () =>
        HttpResponse.json({ success: true, paid: true })
      )
    );
    await useTripStore.getState().toggleBudgetMemberPaid(1, 8, 3, true);
    const stored = useTripStore.getState().budgetItems.find(i => i.id === 8);
    expect(stored?.members?.[0]?.paid).toBe(true);
  });

  it('FE-STORE-BUDGET-010: reorderBudgetItems reorders optimistically and reloads on error', async () => {
    const a = buildBudgetItem({ id: 1, trip_id: 1 });
    const b = buildBudgetItem({ id: 2, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [a, b] });

    // Reorder succeeds
    server.use(
      http.put('/api/trips/1/budget/reorder/items', () =>
        HttpResponse.json({ success: true })
      )
    );
    await useTripStore.getState().reorderBudgetItems(1, [2, 1]);
    const items = useTripStore.getState().budgetItems;
    expect(items[0].id).toBe(2);
    expect(items[1].id).toBe(1);
  });

  it('FE-STORE-BUDGET-011: reorderBudgetItems reloads list on API error', async () => {
    const a = buildBudgetItem({ id: 1, trip_id: 1 });
    const b = buildBudgetItem({ id: 2, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [a, b] });

    const freshItem = buildBudgetItem({ id: 99, trip_id: 1 });
    server.use(
      http.put('/api/trips/1/budget/reorder/items', () =>
        HttpResponse.json({ error: 'error' }, { status: 500 })
      ),
      http.get('/api/trips/1/budget', () =>
        HttpResponse.json({ items: [freshItem] })
      )
    );
    await useTripStore.getState().reorderBudgetItems(1, [2, 1]);
    // After failure, fresh list from server
    expect(useTripStore.getState().budgetItems[0].id).toBe(freshItem.id);
  });

  it('FE-STORE-BUDGET-012: loadBudgetLedger populates transactions, category budgets, and settlement', async () => {
    const transaction = {
      id: 101,
      trip_id: 1,
      type: 'expense',
      title: 'Dinner',
      category: 'Food',
      transaction_date: '2026-05-10',
      currency: 'EUR',
      note: null,
      reservation_id: null,
      payers: [{ user_id: 1, username: 'Alex', amount: 80 }],
      splits: [{ user_id: 2, username: 'Blair', amount: 80 }],
    };
    const budget = { trip_id: 1, category: 'Food', currency: 'EUR', amount: 200, spent: 80, remaining: 120 };
    server.use(
      http.get('/api/trips/1/budget/transactions', () => HttpResponse.json({ transactions: [transaction] })),
      http.get('/api/trips/1/budget/category-budgets', () => HttpResponse.json({ budgets: [budget] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ currencies: [{ currency: 'EUR', balances: [], flows: [] }] }))
    );

    await useTripStore.getState().loadBudgetLedger(1);

    expect(useTripStore.getState().budgetTransactions[0].title).toBe('Dinner');
    expect(useTripStore.getState().budgetCategoryBudgets[0].remaining).toBe(120);
    expect(useTripStore.getState().budgetSettlement?.currencies[0].currency).toBe('EUR');
  });

  it('FE-STORE-BUDGET-013: add/update/delete ledger transactions sync store state', async () => {
    const base = {
      id: 102,
      trip_id: 1,
      type: 'expense',
      title: 'Taxi',
      category: 'Transport',
      transaction_date: '2026-05-11',
      currency: 'USD',
      note: null,
      reservation_id: null,
      payers: [{ user_id: 1, amount: 50 }],
      splits: [{ user_id: 2, amount: 50 }],
    };
    let ledger = [] as typeof base[];
    server.use(
      http.get('/api/trips/1/budget/transactions', () => HttpResponse.json({ transactions: ledger })),
      http.get('/api/trips/1/budget/category-budgets', () => HttpResponse.json({ budgets: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ currencies: [] })),
      http.post('/api/trips/1/budget/transactions', () => {
        ledger = [base];
        return HttpResponse.json({ transaction: base });
      }),
      http.put('/api/trips/1/budget/transactions/102', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        ledger = [{ ...base, title: String(body.title) }];
        return HttpResponse.json({ transaction: ledger[0] });
      }),
      http.delete('/api/trips/1/budget/transactions/102', () => {
        ledger = [];
        return HttpResponse.json({ success: true });
      })
    );

    await useTripStore.getState().addBudgetTransaction(1, {
      type: 'expense',
      title: 'Taxi',
      category: 'Transport',
      transaction_date: '2026-05-11',
      currency: 'USD',
      payers: [{ user_id: 1, amount: 50 }],
      splits: [{ user_id: 2, amount: 50 }],
    });
    expect(useTripStore.getState().budgetTransactions[0].title).toBe('Taxi');

    await useTripStore.getState().updateBudgetTransaction(1, 102, {
      type: 'expense',
      title: 'Train',
      category: 'Transport',
      transaction_date: '2026-05-11',
      currency: 'USD',
      payers: [{ user_id: 1, amount: 50 }],
      splits: [{ user_id: 2, amount: 50 }],
    });
    expect(useTripStore.getState().budgetTransactions[0].title).toBe('Train');

    await useTripStore.getState().deleteBudgetTransaction(1, 102);
    expect(useTripStore.getState().budgetTransactions).toEqual([]);
  });

  it('FE-STORE-BUDGET-014: replaceBudgetCategoryBudgets stores server progress rows', async () => {
    const budgets = [{ trip_id: 1, category: 'Food', currency: 'EUR', amount: 300, spent: 75, remaining: 225 }];
    server.use(
      http.put('/api/trips/1/budget/category-budgets', () => HttpResponse.json({ budgets }))
    );

    await useTripStore.getState().replaceBudgetCategoryBudgets(1, [{ category: 'Food', currency: 'EUR', amount: 300 }]);

    expect(useTripStore.getState().budgetCategoryBudgets).toEqual(budgets);
  });
});
