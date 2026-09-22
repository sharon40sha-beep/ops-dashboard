import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase env vars. Create a .env file with VITE_SUPABASE_URL and ' +
      'VITE_SUPABASE_PUBLISHABLE_KEY (see .env.example).',
  )
}

// Plain client using the publishable (anon) key. There is no Supabase Auth in
// this app — identification is a PIN verified SERVER-SIDE via the verify_pin()
// RPC (the employees table itself is not readable by the anon key), and the
// "session" (who is logged in on this device) lives in localStorage only.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
})
