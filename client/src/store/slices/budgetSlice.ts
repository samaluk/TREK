import { budgetApi } from '../../api/client'
import { offlineDb } from '../../db/offlineDb'
import { budgetRepo } from '../../repo/budgetRepo'
import { mutationQueue, generateUUID } from '../../sync/mutationQueue'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { BudgetCategoryBudget, BudgetItem, BudgetMember, BudgetTransaction } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export type BudgetTransactionInput = Omit<Partial<BudgetTransaction>, 'payers' | 'splits'> & {
  payers: Array<{ user_id: number; amount: number }>
  splits: Array<{ user_id: number; amount: number }>
}

export interface BudgetSlice {
  loadBudgetItems: (tripId: number | string) => Promise<void>
  addBudgetItem: (tripId: number | string, data: Partial<BudgetItem>) => Promise<BudgetItem>
  updateBudgetItem: (tripId: number | string, id: number, data: Partial<BudgetItem>) => Promise<BudgetItem>
  deleteBudgetItem: (tripId: number | string, id: number) => Promise<void>
  setBudgetItemMembers: (tripId: number | string, itemId: number, userIds: number[]) => Promise<{ members: BudgetMember[]; item: BudgetItem }>
  toggleBudgetMemberPaid: (tripId: number | string, itemId: number, userId: number, paid: boolean) => Promise<void>
  reorderBudgetItems: (tripId: number | string, orderedIds: number[]) => Promise<void>
  reorderBudgetCategories: (tripId: number | string, orderedCategories: string[]) => Promise<void>
  loadBudgetLedger: (tripId: number | string) => Promise<void>
  addBudgetTransaction: (tripId: number | string, data: BudgetTransactionInput) => Promise<BudgetTransaction>
  updateBudgetTransaction: (tripId: number | string, id: number, data: BudgetTransactionInput) => Promise<BudgetTransaction>
  deleteBudgetTransaction: (tripId: number | string, id: number) => Promise<void>
  replaceBudgetCategoryBudgets: (tripId: number | string, budgets: Array<{ category: string; currency: string; amount: number }>) => Promise<BudgetCategoryBudget[]>
}

const tempId = () => -Math.floor(Date.now() + Math.random() * 1000)

export const createBudgetSlice = (set: SetState, get: GetState): BudgetSlice => ({
  loadBudgetItems: async (tripId) => {
    try {
      const data = await budgetRepo.list(tripId)
      set({ budgetItems: data.items })
    } catch (err: unknown) {
      console.error('Failed to load budget items:', err)
    }
  },

  addBudgetItem: async (tripId, data) => {
    try {
      const result = await budgetApi.create(tripId, data)
      set(state => ({ budgetItems: [...state.budgetItems, result.item] }))
      return result.item
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error adding budget item'))
    }
  },

  updateBudgetItem: async (tripId, id, data) => {
    try {
      const result = await budgetApi.update(tripId, id, data)
      set(state => ({ budgetItems: state.budgetItems.map(item => item.id === id ? result.item : item) }))
      if (data.reservation_id !== undefined || data.total_price !== undefined) {
        get().loadReservations?.(tripId)
      }
      return result.item
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating budget item'))
    }
  },

  deleteBudgetItem: async (tripId, id) => {
    const previous = get().budgetItems
    set(state => ({ budgetItems: state.budgetItems.filter(item => item.id !== id) }))
    try {
      await budgetApi.delete(tripId, id)
    } catch (err: unknown) {
      set({ budgetItems: previous })
      throw new Error(getApiErrorMessage(err, 'Error deleting budget item'))
    }
  },

  setBudgetItemMembers: async (tripId, itemId, userIds) => {
    const result = await budgetApi.setMembers(tripId, itemId, userIds)
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        item.id === itemId ? { ...item, members: result.members, persons: result.item.persons } : item
      )
    }))
    return result
  },

  toggleBudgetMemberPaid: async (tripId, itemId, userId, paid) => {
    await budgetApi.togglePaid(tripId, itemId, userId, paid)
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        item.id === itemId
          ? { ...item, members: (item.members || []).map(m => m.user_id === userId ? { ...m, paid } : m) }
          : item
      )
    }))
  },

  reorderBudgetItems: async (tripId, orderedIds) => {
    const previous = get().budgetItems
    const byId = new Map(previous.map(item => [item.id, item]))
    const ordered = orderedIds
      .map((id, index) => {
        const item = byId.get(id)
        return item ? { ...item, sort_order: index } : undefined
      })
      .filter((item): item is BudgetItem & { sort_order: number } => Boolean(item))
    const leftovers = previous.filter(item => !orderedIds.includes(item.id))
    set({ budgetItems: [...ordered, ...leftovers] })

    try {
      await budgetApi.reorderItems(tripId, orderedIds)
    } catch (err: unknown) {
      set({ budgetItems: previous })
      await get().loadBudgetItems(tripId)
      console.error('Failed to reorder budget items:', err)
    }
  },

  reorderBudgetCategories: async (tripId, orderedCategories) => {
    const previous = get().budgetItems
    const order = new Map(orderedCategories.map((category, index) => [category, index]))
    const next = [...previous].sort((a, b) => {
      const aOrder = order.get(a.category || 'Other') ?? Number.MAX_SAFE_INTEGER
      const bOrder = order.get(b.category || 'Other') ?? Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
    set({ budgetItems: next })

    try {
      await budgetApi.reorderCategories(tripId, orderedCategories)
    } catch (err: unknown) {
      set({ budgetItems: previous })
      await get().loadBudgetItems(tripId)
      console.error('Failed to reorder budget categories:', err)
    }
  },

  loadBudgetLedger: async (tripId) => {
    try {
      const [transactions, budgets, settlement] = await Promise.all([
        budgetRepo.listTransactions(tripId),
        budgetRepo.listCategoryBudgets(tripId),
        navigator.onLine ? budgetApi.settlement(tripId).catch(() => ({ currencies: [] })) : Promise.resolve({ currencies: [] }),
      ])
      set({
        budgetTransactions: transactions.transactions,
        budgetCategoryBudgets: budgets.budgets,
        budgetSettlement: settlement,
      })
    } catch (err: unknown) {
      console.error('Failed to load budget ledger:', err)
    }
  },

  addBudgetTransaction: async (tripId, data) => {
    if (!navigator.onLine) {
      const optimistic: BudgetTransaction = {
        id: tempId(),
        trip_id: Number(tripId),
        type: data.type || 'expense',
        title: data.title || 'Transaction',
        category: data.category || null,
        transaction_date: data.transaction_date || new Date().toISOString().slice(0, 10),
        note: data.note || null,
        currency: data.currency || get().trip?.currency || 'EUR',
        reservation_id: data.reservation_id || null,
        payers: data.payers.map(p => ({ ...p })),
        splits: data.splits.map(s => ({ ...s })),
      }
      set(state => ({ budgetTransactions: [optimistic, ...state.budgetTransactions] }))
      await offlineDb.budgetTransactions.put(optimistic)
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'POST',
        url: `/trips/${tripId}/budget/transactions`,
        body: data,
        resource: 'budgetTransactions',
        tempId: optimistic.id,
      })
      return optimistic
    }

    try {
      const result = await budgetApi.createTransaction(tripId, data)
      set(state => ({ budgetTransactions: [result.transaction, ...state.budgetTransactions] }))
      await offlineDb.budgetTransactions.put(result.transaction)
      await get().loadBudgetLedger(tripId)
      return result.transaction
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error adding budget transaction'))
    }
  },

  updateBudgetTransaction: async (tripId, id, data) => {
    const previous = get().budgetTransactions
    const optimistic = previous.find(t => t.id === id)
    if (optimistic) {
      const updated = { ...optimistic, ...data, payers: data.payers, splits: data.splits } as BudgetTransaction
      set({ budgetTransactions: previous.map(t => t.id === id ? updated : t) })
      await offlineDb.budgetTransactions.put(updated)
    }

    if (!navigator.onLine) {
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'PUT',
        url: `/trips/${tripId}/budget/transactions/${id}`,
        body: data,
        resource: 'budgetTransactions',
      })
      return get().budgetTransactions.find(t => t.id === id)!
    }

    const result = await budgetApi.updateTransaction(tripId, id, data)
    set(state => ({ budgetTransactions: state.budgetTransactions.map(t => t.id === id ? result.transaction : t) }))
    await offlineDb.budgetTransactions.put(result.transaction)
    await get().loadBudgetLedger(tripId)
    return result.transaction
  },

  deleteBudgetTransaction: async (tripId, id) => {
    const previous = get().budgetTransactions
    set({ budgetTransactions: previous.filter(t => t.id !== id) })
    await offlineDb.budgetTransactions.delete(id)

    if (!navigator.onLine) {
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'DELETE',
        url: `/trips/${tripId}/budget/transactions/${id}`,
        body: null,
        resource: 'budgetTransactions',
        entityId: id,
      })
      return
    }

    try {
      await budgetApi.deleteTransaction(tripId, id)
      await get().loadBudgetLedger(tripId)
    } catch (err: unknown) {
      set({ budgetTransactions: previous })
      throw new Error(getApiErrorMessage(err, 'Error deleting budget transaction'))
    }
  },

  replaceBudgetCategoryBudgets: async (tripId, budgets) => {
    if (!navigator.onLine) {
      const rows = budgets.map(b => ({
        trip_id: Number(tripId),
        category: b.category,
        currency: b.currency,
        amount: b.amount,
        spent: 0,
        remaining: b.amount,
      }))
      set({ budgetCategoryBudgets: rows })
      await offlineDb.budgetCategoryBudgets.where('trip_id').equals(Number(tripId)).delete()
      await offlineDb.budgetCategoryBudgets.bulkPut(rows)
      await mutationQueue.enqueue({
        id: generateUUID(),
        tripId: Number(tripId),
        method: 'PUT',
        url: `/trips/${tripId}/budget/category-budgets`,
        body: { budgets },
        resource: 'budgetCategoryBudgets',
      })
      return rows
    }

    const result = await budgetApi.replaceCategoryBudgets(tripId, budgets)
    set({ budgetCategoryBudgets: result.budgets })
    await offlineDb.budgetCategoryBudgets.where('trip_id').equals(Number(tripId)).delete()
    await offlineDb.budgetCategoryBudgets.bulkPut(result.budgets)
    return result.budgets
  },
})
