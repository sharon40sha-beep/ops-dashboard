import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from '../utils/supabase'
import { useAuth } from './AuthContext'
import type { Asset, Employee, Site, Task } from '../types'

interface DataValue {
  employees: Employee[]
  sites: Site[]
  sitesById: Map<string, Site>
  assets: Asset[]
  /** Open (non-completed) tasks visible to the current user. */
  tasks: Task[]
  /** Completed tasks visible to the current user. */
  history: Task[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const DataContext = createContext<DataValue | null>(null)

const REFRESH_MS = 30_000

export function DataProvider({ children }: { children: ReactNode }) {
  const { session, token, logout } = useAuth()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [history, setHistory] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isAdmin = session?.role === 'admin'

  // Reference data (open with the anon key): employee login list + sites + assets.
  const loadReference = useCallback(async () => {
    const [emp, sit, ast] = await Promise.all([
      supabase.rpc('list_login_employees'),
      supabase.from('sites').select('*').order('id'),
      supabase.from('assets').select('*').order('id'),
    ])
    if (!emp.error) setEmployees((emp.data as Employee[]) ?? [])
    if (!sit.error) setSites((sit.data as Site[]) ?? [])
    if (!ast.error) setAssets((ast.data as Asset[]) ?? [])
  }, [])

  // Tasks + history now come through session-scoped RPCs (Part B).
  const refresh = useCallback(async () => {
    if (!token) {
      setTasks([])
      setHistory([])
      return
    }
    setError(null)
    const [openRes, histRes] = await Promise.all([
      supabase.rpc(isAdmin ? 'list_all_tasks' : 'list_my_tasks', { session_token: token }),
      supabase.rpc('list_task_history', { session_token: token }),
    ])
    const firstError = openRes.error || histRes.error
    if (firstError) {
      // an expired/invalid session forces a fresh login
      if (String(firstError.message).includes('session')) {
        logout()
        return
      }
      setError(firstError.message)
      return
    }
    setTasks((openRes.data as Task[]) ?? [])
    setHistory((histRes.data as Task[]) ?? [])
  }, [token, isAdmin, logout])

  useEffect(() => {
    void loadReference()
  }, [loadReference])

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true)
      await refresh()
      if (!cancelled) setLoading(false)
    }
    void run()

    if (!token) return
    // No realtime under closed RLS — refetch on focus and on a light interval.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const iv = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      clearInterval(iv)
    }
  }, [refresh, token])

  const sitesById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites])

  const value = useMemo<DataValue>(
    () => ({ employees, sites, sitesById, assets, tasks, history, loading, error, refresh }),
    [employees, sites, sitesById, assets, tasks, history, loading, error, refresh],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
