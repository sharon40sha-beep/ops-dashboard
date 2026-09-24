# OPS Dashboard

מערכת ניהול צוות אבטחה/הפעלה — מעקב אחר תנועות נכסים בין מחסנים למפעל בדיקות,
עם backend משותף ב-**Supabase** וסנכרון בזמן אמת בין כל המשתמשים.

**React 18 + Vite + TypeScript** · Context-based state · RTL עברית · PWA · ערכת צבעים כהה-ענברית.
(אותה ארכיטקטורה כמו `fleet-dashboard`.)

## מודל עסקי (הקשר)

- 6 מוצרים (`A1`–`A6`), לכל אחד מחסן-בית עצמאי (`S01`–`S06`).
- מפעל אחד משותף (`S07`) שאליו נעשות רוב התנועות.
- אבטחת מידע: במערכת נשמרים **רק קודים** (`A#`, `S##`, Blue/Green/Red). המשמעות
  האמיתית מנוהלת מחוץ למערכת (מסמך פיזי).

## הרצה מקומית

```bash
cp .env.example .env      # כבר מכיל את פרטי ה-Supabase הנכונים
npm install
npm run dev               # http://localhost:5173
```

`npm run build` — בדיקת טיפוסים (`tsc --noEmit`) + build ל-`dist/`.

## הקמת ה-Database (חד-פעמי)

הרץ ב-**Supabase SQL Editor** לפי הסדר:

1. `supabase/migrations/0001_init.sql` — טבלאות, RLS, פונקציות התחברות, Realtime.
2. `supabase/migrations/0002_seed.sql` — נתוני seed (6 מחסנים + מפעל, 6 מוצרים, 5 עובדים).
3. `supabase/migrations/0003_grants.sql` — הרשאות Postgres ל-anon (מתקן `42501`).
4. `supabase/migrations/0004_admin_employees.sql` — `is_active` + RPCs לניהול עובדים.
5. `supabase/migrations/0005_passwords.sql` — סיסמאות עם hash (bcrypt), מדיניות סיסמה, נעילה אחרי כשלים, ולוג כניסות.

כל הקבצים idempotent (אפשר להריץ שוב).

### בדיקה מהירה אחרי המיגרציה

```sql
select count(*) from public.sites;             -- 7
select count(*) from public.assets;            -- 6
select * from public.list_login_employees();   -- 5 שורות, בלי עמודת pin
select * from public.employees;                -- אמור להיכשל/להחזיר 0 עם anon key (RLS נעול)
```

## אבטחה — אימות סיסמה בצד שרת

⚠️ **חשוב:** טבלת `employees` (כולל ה-hash של הסיסמאות) **אינה קריאה מה-client** עם
ה-anon key — RLS מופעל בלי אף policy של `select`. ההתחברות עוברת דרך פונקציות
`SECURITY DEFINER` בלבד:

- `list_login_employees()` — מחזירה `id/name/role` של עובדים **פעילים** בלבד.
- `verify_pin(emp_id, pin_input)` — משווה `crypt(input, pin_hash)` **בתוך ה-DB** ומחזירה את העובד רק בהתאמה.

**מנגנון הסיסמאות (0005):**
- סיסמאות נשמרות כ-**bcrypt hash** (pgcrypto `crypt` + `gen_salt('bf')`), לא כטקסט גלוי.
- **מדיניות** (נאכפת בצד שרת): לפחות 6 תווים, אות, ספרה וסימן. ולידציה גם בלקוח כתזכורת.
- **נעילה מפני ניחוש:** 3 כשלים רצופים → החשבון נעול ל-30 דקות; בזמן נעילה `verify_pin` דוחה מיד בלי לבדוק סיסמה.
- **לוג כניסות:** כל ניסיון נכתב ל-`login_attempts`; מסך "כניסות" (Admin) מציג את האחרונים דרך `admin_list_login_attempts`.

שום סיסמה/hash לא מגיע לדפדפן. ה-session (מי מחובר במכשיר) נשמר ב-`localStorage` בלבד. אין Supabase Auth.

> החלף את הסיסמאות הזמניות של ה-seed דרך מסך "עובדים" מיד אחרי ההתחברות הראשונה.

## מסכים

| מסך | תפקיד | תיאור |
|-----|--------|-------|
| **משימות** | כולם | Operator רואה רק משימות שלו שאינן `completed`; Admin רואה את כולן. כרטיס `planned` → צ'קליסט (5 סעיפים) → "התחל משימה". כרטיס `active` → "GPS פעיל" + "השלם משימה" (טופס בפועל; סטייה מהמתוכנן מחייבת סיבה). |
| **יצירה** | Admin בלבד | בחירת מוצר (מאתר מתמלא אוטומטית ממחסן-הבית, ניתן לשינוי), יעד (ברירת מחדל `S07`), עובד, קוד רכב, ציר, חלון זמן. |
| **היסטוריה** | כולם | משימות שהושלמו — Planned מול Actual זה מול זה (סטיות מודגשות), עם `audit_log` מתקפל. |
| **עובדים** | Admin בלבד | ניהול עובדים: הוספה, שינוי PIN, שינוי הרשאה, השבתה/הפעלה מחדש. כל פעולה מאמתת את ה-PIN של המנהל בצד שרת (RPCים `admin_*`). לא ניתן להשאיר את המערכת בלי מנהל פעיל. |

## סנכרון בזמן אמת

`DataContext` פותח ערוץ Supabase Realtime (`postgres_changes`) על טבלת `tasks`
ומרענן את הנתונים (debounced) בכל שינוי — כל עדכון סטטוס/checklist/actual מופיע
אצל כל המשתמשים בלי refresh ידני. אינדיקטור "מחובר בזמן אמת" בכותרת.

## מבנה (זהה ל-fleet-dashboard)

```
supabase/migrations/     ← 0001_init.sql + 0002_seed.sql (הרץ ב-Supabase)
index.html · public/     ← manifest.webmanifest + icon-192/512.png + sw.js (PWA)
src/
  main.tsx               ← bootstrap + רישום service worker
  App.tsx                ← AuthProvider > DataProvider > Shell (ניווט לפי role)
  index.css              ← מערכת עיצוב אחת (כהה-ענברית)
  types.ts
  context/AuthContext.tsx   ← session ב-localStorage
  context/DataContext.tsx   ← טעינת נתונים + realtime + employees דרך RPC מאובטח
  lib/ops.ts                ← לוגיקת דומיין טהורה (checklist, זמן, audit)
  utils/supabase.ts
  components/  BottomNav · Toast
  screens/     Login · Tasks · Create · History
```

## מה עדיין לא נבנה (בכוונה)

מסכי ניהול ישויות, GPS אמיתי, Pattern Matching, Learning Dashboard, תוכנית
שבועית/מנוע המלצות, deploy — שלבים מאוחרים יותר.
