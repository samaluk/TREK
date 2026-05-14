import { db } from '../db/database';
import { BudgetCategoryBudget, BudgetTransaction, BudgetTransactionPayer, BudgetTransactionSplit, BudgetTransactionType } from '../types';

type LedgerPerson = {
  user_id: number;
  username: string;
  avatar_url: string | null;
};

type LedgerBalance = LedgerPerson & {
  balance: number;
};

type LedgerFlow = {
  from: LedgerPerson;
  to: LedgerPerson;
  amount: number;
};

type LedgerPartyRow = {
  transaction_id: number;
  user_id: number;
  amount: number;
  username: string;
  avatar: string | null;
};

export type BudgetLedgerTransactionInput = {
  type?: BudgetTransactionType;
  title?: string;
  category?: string | null;
  transaction_date?: string;
  note?: string | null;
  currency?: string;
  reservation_id?: number | null;
  payers?: Array<{ user_id: number; amount: number }>;
  splits?: Array<{ user_id: number; amount: number }>;
};

type LedgerSettlementCurrency = {
  currency: string;
  balances: LedgerBalance[];
  flows: LedgerFlow[];
};

export type LedgerSettlementSummary = {
  currencies: LedgerSettlementCurrency[];
};

export type CategoryBudgetProgress = BudgetCategoryBudget & {
  spent: number;
  remaining: number;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

function normalizeDate(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date().toISOString().slice(0, 10);
}

function normalizeCurrency(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^[A-Z]{3}$/.test(value.trim().toUpperCase())) return value.trim().toUpperCase();
  return fallback || 'EUR';
}

function normalizeAmount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return roundMoney(n);
}

function getTripCurrency(tripId: string | number): string {
  const row = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency?: string | null } | undefined;
  return row?.currency || 'EUR';
}

function loadPayers(transactionIds: number[]): BudgetTransactionPayer[] {
  if (transactionIds.length === 0) return [];
  const placeholders = transactionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT bp.transaction_id, bp.user_id, bp.amount, u.username, u.avatar
    FROM budget_transaction_payers bp
    JOIN users u ON u.id = bp.user_id
    WHERE bp.transaction_id IN (${placeholders})
    ORDER BY u.username ASC
  `).all(...transactionIds) as (BudgetTransactionPayer & { avatar?: string | null })[];
  return rows.map(row => ({ ...row, avatar_url: avatarUrl(row) }));
}

function loadSplits(transactionIds: number[]): BudgetTransactionSplit[] {
  if (transactionIds.length === 0) return [];
  const placeholders = transactionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT bs.transaction_id, bs.user_id, bs.amount, u.username, u.avatar
    FROM budget_transaction_splits bs
    JOIN users u ON u.id = bs.user_id
    WHERE bs.transaction_id IN (${placeholders})
    ORDER BY u.username ASC
  `).all(...transactionIds) as (BudgetTransactionSplit & { avatar?: string | null })[];
  return rows.map(row => ({ ...row, avatar_url: avatarUrl(row) }));
}

function attachParties(transactions: BudgetTransaction[]): BudgetTransaction[] {
  const ids = transactions.map(transaction => transaction.id);
  const payersById = new Map<number, BudgetTransactionPayer[]>();
  const splitsById = new Map<number, BudgetTransactionSplit[]>();
  for (const payer of loadPayers(ids)) {
    const rows = payersById.get(payer.transaction_id) ?? [];
    rows.push(payer);
    payersById.set(payer.transaction_id, rows);
  }
  for (const split of loadSplits(ids)) {
    const rows = splitsById.get(split.transaction_id) ?? [];
    rows.push(split);
    splitsById.set(split.transaction_id, rows);
  }
  return transactions.map(transaction => ({
    ...transaction,
    payers: payersById.get(transaction.id) ?? [],
    splits: splitsById.get(transaction.id) ?? [],
  }));
}

function saveParties(transactionId: number, payers: BudgetLedgerTransactionInput['payers'], splits: BudgetLedgerTransactionInput['splits']) {
  db.prepare('DELETE FROM budget_transaction_payers WHERE transaction_id = ?').run(transactionId);
  db.prepare('DELETE FROM budget_transaction_splits WHERE transaction_id = ?').run(transactionId);

  const insertPayer = db.prepare('INSERT INTO budget_transaction_payers (transaction_id, user_id, amount) VALUES (?, ?, ?)');
  const insertSplit = db.prepare('INSERT INTO budget_transaction_splits (transaction_id, user_id, amount) VALUES (?, ?, ?)');
  for (const payer of payers || []) {
    const amount = normalizeAmount(payer.amount);
    if (amount > 0) insertPayer.run(transactionId, payer.user_id, amount);
  }
  for (const split of splits || []) {
    const amount = normalizeAmount(split.amount);
    if (amount > 0) insertSplit.run(transactionId, split.user_id, amount);
  }
}

export function listBudgetTransactions(tripId: string | number): BudgetTransaction[] {
  const transactions = db.prepare(`
    SELECT *
    FROM budget_transactions
    WHERE trip_id = ?
    ORDER BY transaction_date DESC, id DESC
  `).all(tripId) as BudgetTransaction[];
  return attachParties(transactions);
}

export function getBudgetTransaction(tripId: string | number, transactionId: string | number): BudgetTransaction | null {
  const transaction = db.prepare(`
    SELECT * FROM budget_transactions WHERE trip_id = ? AND id = ?
  `).get(tripId, transactionId) as BudgetTransaction | undefined;
  return transaction ? attachParties([transaction])[0] : null;
}

export function createBudgetTransaction(tripId: string | number, data: BudgetLedgerTransactionInput): BudgetTransaction | { error: string; status: number } {
  if (!data.title?.trim()) return { error: 'Title is required', status: 400 };
  if (!data.payers?.length) return { error: 'At least one payer is required', status: 400 };
  if (!data.splits?.length) return { error: 'At least one split participant is required', status: 400 };

  const tripCurrency = getTripCurrency(tripId);
  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO budget_transactions
        (trip_id, type, title, category, transaction_date, note, currency, reservation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tripId,
      data.type || 'expense',
      data.title!.trim(),
      data.category?.trim() || null,
      normalizeDate(data.transaction_date),
      data.note?.trim() || null,
      normalizeCurrency(data.currency, tripCurrency),
      data.reservation_id || null,
    );
    const id = Number(result.lastInsertRowid);
    saveParties(id, data.payers, data.splits);
    return id;
  });

  return getBudgetTransaction(tripId, create())!;
}

export function updateBudgetTransaction(tripId: string | number, transactionId: string | number, data: BudgetLedgerTransactionInput): BudgetTransaction | null | { error: string; status: number } {
  const existing = getBudgetTransaction(tripId, transactionId);
  if (!existing) return null;
  if (data.title !== undefined && !data.title.trim()) return { error: 'Title is required', status: 400 };
  if (data.payers !== undefined && data.payers.length === 0) return { error: 'At least one payer is required', status: 400 };
  if (data.splits !== undefined && data.splits.length === 0) return { error: 'At least one split participant is required', status: 400 };

  const tripCurrency = getTripCurrency(tripId);
  db.transaction(() => {
    db.prepare(`
      UPDATE budget_transactions SET
        type = COALESCE(?, type),
        title = COALESCE(?, title),
        category = CASE WHEN ? THEN ? ELSE category END,
        transaction_date = COALESCE(?, transaction_date),
        note = CASE WHEN ? THEN ? ELSE note END,
        currency = COALESCE(?, currency),
        reservation_id = CASE WHEN ? THEN ? ELSE reservation_id END,
        updated_at = CURRENT_TIMESTAMP
      WHERE trip_id = ? AND id = ?
    `).run(
      data.type || null,
      data.title !== undefined ? data.title.trim() : null,
      data.category !== undefined ? 1 : 0, data.category?.trim() || null,
      data.transaction_date ? normalizeDate(data.transaction_date) : null,
      data.note !== undefined ? 1 : 0, data.note?.trim() || null,
      data.currency !== undefined ? normalizeCurrency(data.currency, tripCurrency) : null,
      data.reservation_id !== undefined ? 1 : 0, data.reservation_id || null,
      tripId,
      transactionId,
    );
    if (data.payers !== undefined || data.splits !== undefined) {
      saveParties(Number(transactionId), data.payers ?? existing.payers, data.splits ?? existing.splits);
    }
  })();

  return getBudgetTransaction(tripId, transactionId);
}

export function deleteBudgetTransaction(tripId: string | number, transactionId: string | number): boolean {
  const result = db.prepare('DELETE FROM budget_transactions WHERE trip_id = ? AND id = ?').run(tripId, transactionId);
  return result.changes > 0;
}

export function replaceCategoryBudgets(tripId: string | number, budgets: Array<{ category: string; currency: string; amount: number }>): CategoryBudgetProgress[] {
  db.transaction(() => {
    db.prepare('DELETE FROM budget_category_budgets WHERE trip_id = ?').run(tripId);
    const insert = db.prepare(`
      INSERT INTO budget_category_budgets (trip_id, category, currency, amount)
      VALUES (?, ?, ?, ?)
    `);
    for (const budget of budgets) {
      if (!budget.category?.trim()) continue;
      const amount = normalizeAmount(budget.amount);
      insert.run(tripId, budget.category.trim(), normalizeCurrency(budget.currency, getTripCurrency(tripId)), amount);
    }
  })();

  return getCategoryBudgetProgress(tripId);
}

function personFromRow(row: LedgerPartyRow): LedgerPerson {
  return {
    user_id: row.user_id,
    username: row.username,
    avatar_url: avatarUrl(row),
  };
}

function ensureBalance(
  balances: Map<number, LedgerBalance>,
  row: LedgerPartyRow,
): LedgerBalance {
  const existing = balances.get(row.user_id);
  if (existing) return existing;

  const balance = { ...personFromRow(row), balance: 0 };
  balances.set(row.user_id, balance);
  return balance;
}

function buildFlows(balances: LedgerBalance[]): LedgerFlow[] {
  const people = balances.filter(b => Math.abs(b.balance) > 0.01);
  const debtors = people.filter(p => p.balance < -0.01).map(p => ({ ...p, amount: -p.balance }));
  const creditors = people.filter(p => p.balance > 0.01).map(p => ({ ...p, amount: p.balance }));

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const flows: LedgerFlow[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const amount = Math.min(debtors[debtorIndex].amount, creditors[creditorIndex].amount);
    if (amount > 0.01) {
      flows.push({
        from: {
          user_id: debtors[debtorIndex].user_id,
          username: debtors[debtorIndex].username,
          avatar_url: debtors[debtorIndex].avatar_url,
        },
        to: {
          user_id: creditors[creditorIndex].user_id,
          username: creditors[creditorIndex].username,
          avatar_url: creditors[creditorIndex].avatar_url,
        },
        amount: roundMoney(amount),
      });
    }

    debtors[debtorIndex].amount -= amount;
    creditors[creditorIndex].amount -= amount;
    if (debtors[debtorIndex].amount < 0.01) debtorIndex++;
    if (creditors[creditorIndex].amount < 0.01) creditorIndex++;
  }

  return flows;
}

export function calculateLedgerSettlement(tripId: string | number): LedgerSettlementSummary {
  const transactions = db.prepare(`
    SELECT *
    FROM budget_transactions
    WHERE trip_id = ?
    ORDER BY transaction_date ASC, id ASC
  `).all(tripId) as BudgetTransaction[];

  if (transactions.length === 0) return { currencies: [] };

  const transactionIds = transactions.map(t => t.id);
  const placeholders = transactionIds.map(() => '?').join(',');
  const payers = db.prepare(`
    SELECT bp.transaction_id, bp.user_id, bp.amount, u.username, u.avatar
    FROM budget_transaction_payers bp
    JOIN users u ON u.id = bp.user_id
    WHERE bp.transaction_id IN (${placeholders})
  `).all(...transactionIds) as LedgerPartyRow[];
  const splits = db.prepare(`
    SELECT bs.transaction_id, bs.user_id, bs.amount, u.username, u.avatar
    FROM budget_transaction_splits bs
    JOIN users u ON u.id = bs.user_id
    WHERE bs.transaction_id IN (${placeholders})
  `).all(...transactionIds) as LedgerPartyRow[];

  const payersByTransaction = new Map<number, LedgerPartyRow[]>();
  const splitsByTransaction = new Map<number, LedgerPartyRow[]>();
  for (const payer of payers) {
    const rows = payersByTransaction.get(payer.transaction_id) ?? [];
    rows.push(payer);
    payersByTransaction.set(payer.transaction_id, rows);
  }
  for (const split of splits) {
    const rows = splitsByTransaction.get(split.transaction_id) ?? [];
    rows.push(split);
    splitsByTransaction.set(split.transaction_id, rows);
  }

  const balancesByCurrency = new Map<string, Map<number, LedgerBalance>>();

  for (const transaction of transactions) {
    const currencyBalances = balancesByCurrency.get(transaction.currency) ?? new Map<number, LedgerBalance>();
    balancesByCurrency.set(transaction.currency, currencyBalances);

    for (const payer of payersByTransaction.get(transaction.id) ?? []) {
      ensureBalance(currencyBalances, payer).balance += payer.amount;
    }
    for (const split of splitsByTransaction.get(transaction.id) ?? []) {
      ensureBalance(currencyBalances, split).balance -= split.amount;
    }
  }

  const currencies = Array.from(balancesByCurrency.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, balances]) => {
      const roundedBalances = Array.from(balances.values()).map(balance => ({
        ...balance,
        balance: roundMoney(balance.balance),
      }));
      roundedBalances.sort((a, b) => a.username.localeCompare(b.username));

      return {
        currency,
        balances: roundedBalances,
        flows: buildFlows(roundedBalances),
      };
    });

  return { currencies };
}

export function getCategoryBudgetProgress(tripId: string | number): CategoryBudgetProgress[] {
  const budgets = db.prepare(`
    SELECT *
    FROM budget_category_budgets
    WHERE trip_id = ?
    ORDER BY category ASC, currency ASC
  `).all(tripId) as BudgetCategoryBudget[];

  const spending = db.prepare(`
    SELECT bt.category, bt.currency, COALESCE(SUM(bp.amount), 0) as spent
    FROM budget_transactions bt
    JOIN budget_transaction_payers bp ON bp.transaction_id = bt.id
    WHERE bt.trip_id = ?
      AND bt.type IN ('expense', 'adjustment')
      AND bt.category IS NOT NULL
    GROUP BY bt.category, bt.currency
  `).all(tripId) as { category: string; currency: string; spent: number }[];

  const spentByCategory = new Map(spending.map(row => [`${row.category}\0${row.currency}`, row.spent]));

  return budgets.map(budget => {
    const spent = roundMoney(spentByCategory.get(`${budget.category}\0${budget.currency}`) ?? 0);
    return {
      ...budget,
      spent,
      remaining: roundMoney(budget.amount - spent),
    };
  });
}
