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
import type { Asset, Employee, Route, Site, Trip, Vehicle } from '../types'

interface DataValue {
  employees: Employee[]
  sites: Site[]
  sitesById: Map<string, Site>
  assets: Asset[]
  routes: Route[]
  vehicles: Vehicle[]
  /** Open (non-completed) trips visible to the current user. */
  trips: Trip[]
  /** Completed trips visible to the current user. */
  history: Trip[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** re-pull reference lists (assets/sites/routes/vehicles) after admin edits */
  refreshReference: () => Promise<void>
}

const DataContext = createContext<DataValue | null>(null)

const REFRESH_MS = 30_000

export function DataProvider({ children }: { children: ReactNode }) {
  const { session, token, logout } = useAuth()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [trips, setTrips] = useState<Trip[]>([])
  const [history, setHistory] = useState<Trip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isAdmin = session?.role === 'admin'

  // Reference data (open with the anon key): employee login list + sites + assets.
  const loadReference = useCallback(async () => {
    const [emp, sit, ast, rou, veh] = await Promise.all([
      supabase.rpc('list_login_employees'),
      supabase.from('sites').select('*').order('id'),
      supabase.from('assets').select('*').order('id'),
      supabase.from('routes').select('*').order('id'),
      supabase.from('vehicles').select('*').order('id'),
    ])
    if (!emp.error) setEmployees((emp.data as Employee[]) ?? [])
    if (!sit.error) setSites((sit.data as Site[]) ?? [])
    if (!ast.error) setAssets((ast.data as Asset[]) ?? [])
    if (!rou.error) setRoutes((rou.data as Route[]) ?? [])
    if (!veh.error) setVehicles((veh.data as Vehicle[]) ?? [])
  }, [])

  // Tasks + history now come through session-scoped RPCs (Part B).
  const refresh = useCallback(async () => {
    if (!token) {
      setTrips([])
      setHistory([])
      return
    }
    setError(null)
    const [openRes, histRes] = await Promise.all([
      supabase.rpc(isAdmin ? 'list_all_trips' : 'list_my_trips', { session_token: token }),
      supabase.rpc('list_trip_history', { session_token: token }),
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
    // these RPCs return a jsonb array of trips (each with nested items)
    setTrips((openRes.data as Trip[]) ?? [])
    setHistory((histRes.data as Trip[]) ?? [])
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
    () => ({
      employees, sites, sitesById, assets, routes, vehicles,
      trips, history, loading, error, refresh, refreshReference: loadReference,
    }),
    [employees, sites, sitesById, assets, routes, vehicles, trips, history, loading, error, refresh, loadReference],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
