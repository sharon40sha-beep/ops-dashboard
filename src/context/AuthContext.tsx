import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../utils/supabase'
import type { Session } from '../types'

const SESSION_KEY = 'ops.session'
const TOKEN_KEY = 'ops.admin_token'

interface AuthValue {
  session: Session | null
  /** Admin session token (12h) — present only for a logged-in admin. */
  adminToken: string | null
  login: (session: Session, adminToken?: string | null) => void
  setAdminToken: (token: string | null) => void
  logout: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readSession)
  const [adminToken, setAdminTokenState] = useState<string | null>(readToken)

  useEffect(() => {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
      else localStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore storage errors (private mode etc.) */
    }
  }, [session])

  useEffect(() => {
    try {
      if (adminToken) localStorage.setItem(TOKEN_KEY, adminToken)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }, [adminToken])

  function login(next: Session, token?: string | null) {
    setSession(next)
    if (token !== undefined) setAdminTokenState(token)
  }

  function logout() {
    if (adminToken) {
      // best-effort: end the server-side admin session
      void supabase.rpc('admin_logout', { session_token: adminToken })
    }
    setAdminTokenState(null)
    setSession(null)
  }

  return (
    <AuthContext.Provider
      value={{ session, adminToken, login, setAdminToken: setAdminTokenState, logout }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
