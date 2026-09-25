import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../utils/supabase'
import type { Session } from '../types'

const SESSION_KEY = 'ops.session'
const TOKEN_KEY = 'ops.session_token'

interface AuthValue {
  session: Session | null
  /** Server session token (Part A) — present for any logged-in employee. */
  token: string | null
  login: (session: Session, token: string | null) => void
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
  const [token, setTokenState] = useState<string | null>(readToken)

  useEffect(() => {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
      else localStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
  }, [session])

  useEffect(() => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }, [token])

  function login(next: Session, nextToken: string | null) {
    setSession(next)
    setTokenState(nextToken)
  }

  function logout() {
    if (token) void supabase.rpc('app_logout', { session_token: token })
    setTokenState(null)
    setSession(null)
  }

  // A.3 — session dies when the app goes to background / the screen locks.
  // Clear local auth immediately (and best-effort end the server session);
  // coming back to foreground therefore requires a fresh login.
  const tokenRef = useRef(token)
  useEffect(() => {
    tokenRef.current = token
  }, [token])

  useEffect(() => {
    function clearForBackground() {
      const t = tokenRef.current
      if (t) {
        try {
          void supabase.rpc('app_logout', { session_token: t })
        } catch {
          /* best effort */
        }
      }
      try {
        localStorage.removeItem(SESSION_KEY)
        localStorage.removeItem(TOKEN_KEY)
      } catch {
        /* ignore */
      }
      setSession(null)
      setTokenState(null)
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') clearForBackground()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', clearForBackground)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', clearForBackground)
    }
  }, [])

  return (
    <AuthContext.Provider value={{ session, token, login, logout }}>{children}</AuthContext.Provider>
  )
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
