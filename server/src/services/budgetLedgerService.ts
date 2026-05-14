import { db } from '../db/database';
import { BudgetCategoryBudget, BudgetTransaction } from '../types';

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
