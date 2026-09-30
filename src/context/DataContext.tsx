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
import type { Asset, DutyShift, Employee, Route, Site, SiteEntryPoint, SiteType, Trip, Vehicle } from '../types'

interface DataValue {
  employees: Employee[]
  sites: Site[]
  sitesById: Map<string, Site>
  siteTypes: SiteType[]
  /** site_type_id -> label, for rendering a site's type. */
  siteTypesById: Map<string, string>
  entryPoints: SiteEntryPoint[]
  assets: Asset[]
  routes: Route[]
  vehicles: Vehicle[]
  /** Open (non-completed) trips visible to the current user. */
  trips: Trip[]
  /** Completed trips visible to the current user. */
  history: Trip[]
  /** Open (non-completed) duty shifts. */
  duties: DutyShift[]
  /** Completed duty shifts. */
  dutyHistory: DutyShift[]
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
  const [siteTypes, setSiteTypes] = useState<SiteType[]>([])
  const [entryPoints, setEntryPoints] = useState<SiteEntryPoint[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [trips, setTrips] = useState<Trip[]>([])
  const [history, setHistory] = useState<Trip[]>([])
  const [duties, setDuties] = useState<DutyShift[]>([])
  const [dutyHistory, setDutyHistory] = useState<DutyShift[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isAdmin = session?.role === 'admin'

  // Reference data (open with the anon key): employee login list + sites + assets.
  const loadReference = useCallback(async () => {
    const [emp, sit, ast, rou, veh, sty, ent] = await Promise.all([
      supabase.rpc('list_login_employees'),
      supabase.from('sites').select('*').order('id'),
      supabase.from('assets').select('*').order('id'),
      supabase.from('routes').select('*').order('id'),
      supabase.from('vehicles').select('*').order('id'),
      supabase.from('site_types').select('*').order('label'),
      supabase.from('site_entry_points').select('*').order('label'),
    ])
    if (!emp.error) setEmployees((emp.data as Employee[]) ?? [])
    if (!sit.error) setSites((sit.data as Site[]) ?? [])
    if (!ast.error) setAssets((ast.data as Asset[]) ?? [])
    if (!rou.error) setRoutes((rou.data as Route[]) ?? [])
    if (!veh.error) setVehicles((veh.data as Vehicle[]) ?? [])
    if (!sty.error) setSiteTypes((sty.data as SiteType[]) ?? [])
    if (!ent.error) setEntryPoints((ent.data as SiteEntryPoint[]) ?? [])
  }, [])

  // Tasks + history now come through session-scoped RPCs (Part B).
  const refresh = useCallback(async () => {
    if (!token) {
      setTrips([]); setHistory([]); setDuties([]); setDutyHistory([])
      return
    }
    setError(null)
    const [openRes, histRes, dutyRes, dutyHistRes] = await Promise.all([
      supabase.rpc(isAdmin ? 'list_all_trips' : 'list_my_trips', { session_token: token }),
      supabase.rpc('list_trip_history', { session_token: token }),
      supabase.rpc(isAdmin ? 'list_all_duties' : 'list_my_duties', { session_token: token }),
      supabase.rpc('list_duty_history', { session_token: token }),
    ])
    const firstError = openRes.error || histRes.error || dutyRes.error || dutyHistRes.error
    if (firstError) {
      // an expired/invalid session forces a fresh login
      if (String(firstError.message).includes('session')) {
        logout()
        return
      }
      setError(firstError.message)
      return
    }
    // these RPCs return a jsonb array (trips carry nested items; duties carry a label)
    setTrips((openRes.data as Trip[]) ?? [])
    setHistory((histRes.data as Trip[]) ?? [])
    setDuties((dutyRes.data as DutyShift[]) ?? [])
    setDutyHistory((dutyHistRes.data as DutyShift[]) ?? [])
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
  const siteTypesById = useMemo(() => new Map(siteTypes.map((t) => [t.id, t.label])), [siteTypes])

  const value = useMemo<DataValue>(
    () => ({
      employees, sites, sitesById, siteTypes, siteTypesById, entryPoints, assets, routes, vehicles,
      trips, history, duties, dutyHistory, loading, error, refresh, refreshReference: loadReference,
    }),
    [employees, sites, sitesById, siteTypes, siteTypesById, entryPoints, assets, routes, vehicles, trips, history, duties, dutyHistory, loading, error, refresh, loadReference],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
