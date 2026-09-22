import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '../types'

const STORAGE_KEY = 'ops.session'

interface AuthValue {
  session: Session | null
  login: (session: Session) => void
  logout: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as Session) : null
    } catch {
      return null
    }
  })

  useEffect(() => {
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore storage errors (private mode etc.) */
    }
  }, [session])

  return (
    <AuthContext.Provider value={{ session, login: setSession, logout: () => setSession(null) }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
