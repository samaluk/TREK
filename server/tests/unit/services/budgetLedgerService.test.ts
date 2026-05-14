import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: () => true,
    isOwner: () => true,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createTrip, createUser } from '../../helpers/factories';
import {
  calculateLedgerSettlement,
  getCategoryBudgetProgress,
} from '../../../src/services/budgetLedgerService';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

afterAll(() => {
  testDb.close();
});

function createLedgerTrip() {
  const alice = createUser(testDb, { username: 'alice' }).user;
  const bob = createUser(testDb, { username: 'bob' }).user;
  const carol = createUser(testDb, { username: 'carol' }).user;
  const trip = createTrip(testDb, alice.id, { title: 'Ledger Trip' });
  return { alice, bob, carol, trip };
}

function createTransaction(
  tripId: number,
  data: {
    type?: 'expense' | 'settlement' | 'adjustment';
    title?: string;
    category?: string | null;
    currency?: string;
    payers: Array<{ userId: number; amount: number }>;
    splits: Array<{ userId: number; amount: number }>;
  },
): number {
  const result = testDb.prepare(`
    INSERT INTO budget_transactions
      (trip_id, type, title, category, transaction_date, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    data.type ?? 'expense',
    data.title ?? 'Transaction',
    data.category ?? null,
    '2026-05-13',
    data.currency ?? 'USD',
  );

  const transactionId = Number(result.lastInsertRowid);
  const insertPayer = testDb.prepare(`
    INSERT INTO budget_transaction_payers (transaction_id, user_id, amount)
    VALUES (?, ?, ?)
  `);
  const insertSplit = testDb.prepare(`
    INSERT INTO budget_transaction_splits (transaction_id, user_id, amount)
    VALUES (?, ?, ?)
  `);

  for (const payer of data.payers) insertPayer.run(transactionId, payer.userId, payer.amount);
  for (const split of data.splits) insertSplit.run(transactionId, split.userId, split.amount);
  return transactionId;
}

describe('budget ledger schema', () => {
  it('creates ledger tables and indexes from schema plus migrations', () => {
    for (const tableName of [
      'budget_transactions',
      'budget_transaction_payers',
      'budget_transaction_splits',
      'budget_category_budgets',
    ]) {
      const table = testDb.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(tableName);
      expect(table).toBeDefined();
    }

    for (const indexName of [
      'idx_budget_transactions_trip_id',
      'idx_budget_transactions_trip_date',
      'idx_budget_transactions_category',
      'idx_budget_transaction_payers_user',
      'idx_budget_transaction_splits_user',
      'idx_budget_category_budgets_trip',
    ]) {
      const index = testDb.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?
      `).get(indexName);
      expect(index).toBeDefined();
    }
  });
});

describe('calculateLedgerSettlement', () => {
  it('allows a payer who is not one of the split participants', () => {
    const { alice, bob, trip } = createLedgerTrip();
    createTransaction(trip.id, {
      payers: [{ userId: alice.id, amount: 120 }],
      splits: [{ userId: bob.id, amount: 120 }],
    });

    const usd = calculateLedgerSettlement(trip.id).currencies[0];
    expect(usd.currency).toBe('USD');
    expect(usd.balances.find(b => b.user_id === alice.id)?.balance).toBe(120);
    expect(usd.balances.find(b => b.user_id === bob.id)?.balance).toBe(-120);
    expect(usd.flows[0]).toMatchObject({
      from: { user_id: bob.id },
      to: { user_id: alice.id },
      amount: 120,
    });
  });

  it('treats a settlement as another transaction that reduces open balances', () => {
    const { alice, bob, trip } = createLedgerTrip();
    createTransaction(trip.id, {
      title: 'Dinner',
      payers: [{ userId: alice.id, amount: 100 }],
      splits: [
        { userId: alice.id, amount: 50 },
        { userId: bob.id, amount: 50 },
      ],
    });
    createTransaction(trip.id, {
      type: 'settlement',
      title: 'Bob repays Alice',
      payers: [{ userId: bob.id, amount: 20 }],
      splits: [{ userId: alice.id, amount: 20 }],
    });

    const usd = calculateLedgerSettlement(trip.id).currencies[0];
    expect(usd.balances.find(b => b.user_id === alice.id)?.balance).toBe(30);
    expect(usd.balances.find(b => b.user_id === bob.id)?.balance).toBe(-30);
    expect(usd.flows).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ user_id: bob.id }),
        to: expect.objectContaining({ user_id: alice.id }),
        amount: 30,
      }),
    ]);
  });

  it('supports multiple payers on one expense', () => {
    const { alice, bob, trip } = createLedgerTrip();
    createTransaction(trip.id, {
      payers: [
        { userId: alice.id, amount: 60 },
        { userId: bob.id, amount: 40 },
      ],
      splits: [
        { userId: alice.id, amount: 50 },
        { userId: bob.id, amount: 50 },
      ],
    });

    const usd = calculateLedgerSettlement(trip.id).currencies[0];
    expect(usd.balances.find(b => b.user_id === alice.id)?.balance).toBe(10);
    expect(usd.balances.find(b => b.user_id === bob.id)?.balance).toBe(-10);
    expect(usd.flows[0]).toMatchObject({
      from: { user_id: bob.id },
      to: { user_id: alice.id },
      amount: 10,
    });
  });

  it('groups balances by original transaction currency without conversion', () => {
    const { alice, bob, carol, trip } = createLedgerTrip();
    createTransaction(trip.id, {
      currency: 'USD',
      payers: [{ userId: alice.id, amount: 100 }],
      splits: [{ userId: bob.id, amount: 100 }],
    });
    createTransaction(trip.id, {
      currency: 'EUR',
      payers: [{ userId: carol.id, amount: 90 }],
      splits: [{ userId: alice.id, amount: 90 }],
    });

    const summary = calculateLedgerSettlement(trip.id);
    expect(summary.currencies.map(c => c.currency)).toEqual(['EUR', 'USD']);
    expect(summary.currencies.find(c => c.currency === 'USD')?.balances.find(b => b.user_id === alice.id)?.balance).toBe(100);
    expect(summary.currencies.find(c => c.currency === 'EUR')?.balances.find(b => b.user_id === carol.id)?.balance).toBe(90);
  });
});

describe('getCategoryBudgetProgress', () => {
  it('derives remaining spend from categorized non-settlement transactions', () => {
    const { alice, bob, trip } = createLedgerTrip();
    testDb.prepare(`
      INSERT INTO budget_category_budgets (trip_id, category, currency, amount)
      VALUES (?, ?, ?, ?)
    `).run(trip.id, 'Food', 'USD', 150);

    createTransaction(trip.id, {
      title: 'Lunch',
      category: 'Food',
      payers: [{ userId: alice.id, amount: 90 }],
      splits: [{ userId: bob.id, amount: 90 }],
    });
    createTransaction(trip.id, {
      type: 'settlement',
      title: 'Repayment',
      category: 'Food',
      payers: [{ userId: bob.id, amount: 20 }],
      splits: [{ userId: alice.id, amount: 20 }],
    });

    expect(getCategoryBudgetProgress(trip.id)).toEqual([
      expect.objectContaining({
        category: 'Food',
        currency: 'USD',
        amount: 150,
        spent: 90,
        remaining: 60,
      }),
    ]);
  });
});
