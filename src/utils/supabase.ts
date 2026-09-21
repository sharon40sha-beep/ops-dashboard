import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error(
    'חסרים משתני סביבה: ודא ש-VITE_SUPABASE_URL ו-VITE_SUPABASE_PUBLISHABLE_KEY מוגדרים בקובץ .env'
  );
}

export const supabase = createClient(url, key, {
  auth: {
    // אנחנו לא משתמשים ב-Supabase Auth — session מנוהל ב-localStorage מול טבלת employees.
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    params: { eventsPerSecond: 5 },
  },
});
