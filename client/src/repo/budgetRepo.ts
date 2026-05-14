import { budgetApi } from '../api/client'
import { offlineDb, upsertBudgetCategoryBudgets, upsertBudgetItems, upsertBudgetTransactions } from '../db/offlineDb'
import type { BudgetCategoryBudget, BudgetItem, BudgetTransaction } from '../types'

export const budgetRepo = {
  async list(tripId: number | string): Promise<{ items: BudgetItem[] }> {
    if (!navigator.onLine) {
      const cached = await offlineDb.budgetItems
        .where('trip_id')
        .equals(Number(tripId))
        .toArray()
      return { items: cached }
    }
    const result = await budgetApi.list(tripId)
    upsertBudgetItems(result.items)
    return result
  },
  async listTransactions(tripId: number | string): Promise<{ transactions: BudgetTransaction[] }> {
    if (!navigator.onLine) {
      const transactions = await offlineDb.budgetTransactions
        .where('trip_id')
        .equals(Number(tripId))
        .toArray()
      transactions.sort((a, b) => {
        const dateOrder = b.transaction_date.localeCompare(a.transaction_date)
        return dateOrder || b.id - a.id
      })
      return { transactions }
    }
    const result = await budgetApi.transactions(tripId)
    await upsertBudgetTransactions(result.transactions)
    return result
  },
  async listCategoryBudgets(tripId: number | string): Promise<{ budgets: BudgetCategoryBudget[] }> {
    if (!navigator.onLine) {
      const budgets = await offlineDb.budgetCategoryBudgets
        .where('trip_id')
        .equals(Number(tripId))
        .toArray()
      return { budgets }
    }
    const result = await budgetApi.categoryBudgets(tripId)
    await upsertBudgetCategoryBudgets(result.budgets)
    return result
  },
}
