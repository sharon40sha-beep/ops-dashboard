import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from '../utils/supabase'
import type { Asset, Employee, Site, Task } from '../types'

interface DataValue {
  employees: Employee[]
  sites: Site[]
  sitesById: Map<string, Site>
  assets: Asset[]
  tasks: Task[]
  loading: boolean
  error: string | null
  /** true once the realtime channel is subscribed */
  live: boolean
  refresh: () => Promise<void>
}

const DataContext = createContext<DataValue | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)

  // Debounce refetches triggered by a burst of realtime events.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      // employees come from a SECURITY DEFINER RPC that returns id/name/role
      // only — the employees table (incl. PINs) is NOT selectable by anon.
      const [emp, sit, ast, tsk] = await Promise.all([
        supabase.rpc('list_login_employees'),
        supabase.from('sites').select('*').order('id'),
        supabase.from('assets').select('*').order('id'),
        supabase.from('tasks').select('*').order('created_at', { ascending: false }),
      ])
      const firstError = emp.error || sit.error || ast.error || tsk.error
      if (firstError) throw firstError
      setEmployees((emp.data as Employee[]) ?? [])
      setSites((sit.data as Site[]) ?? [])
      setAssets((ast.data as Asset[]) ?? [])
      setTasks((tsk.data as Task[]) ?? [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(() => {
      void refresh()
    }, 200)
  }, [refresh])

  useEffect(() => {
    void refresh()

    // Realtime: any change on tasks → refetch (debounced).
    const channel = supabase
      .channel('ops-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, scheduleRefresh)
      .subscribe((status) => {
        setLive(status === 'SUBSCRIBED')
      })

    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current)
      void supabase.removeChannel(channel)
    }
  }, [refresh, scheduleRefresh])

  const sitesById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites])

  const value = useMemo<DataValue>(
    () => ({ employees, sites, sitesById, assets, tasks, loading, error, live, refresh }),
    [employees, sites, sitesById, assets, tasks, loading, error, live, refresh],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
