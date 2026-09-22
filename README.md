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

שני הקבצים idempotent (אפשר להריץ שוב).

### בדיקה מהירה אחרי המיגרציה

```sql
select count(*) from public.sites;             -- 7
select count(*) from public.assets;            -- 6
select * from public.list_login_employees();   -- 5 שורות, בלי עמודת pin
select * from public.employees;                -- אמור להיכשל/להחזיר 0 עם anon key (RLS נעול)
```

## אבטחה — אימות PIN בצד שרת

⚠️ **חשוב:** טבלת `employees` (כולל ה-PINs) **אינה קריאה מה-client** עם ה-anon key —
RLS מופעל בלי אף policy של `select`. ההתחברות עוברת דרך שתי פונקציות
`SECURITY DEFINER`:

- `list_login_employees()` — מחזירה `id/name/role` בלבד (לרשימת ההתחברות ובורר העובד). **לא** מחזירה PIN.
- `verify_pin(emp_id, pin_input)` — משווה את ה-PIN **בתוך ה-DB** ומחזירה את העובד רק בהתאמה.

כך שום PIN לא מגיע לדפדפן, וה-client לא יכול לשלוף את הטבלה. ה-session (מי מחובר
במכשיר) נשמר ב-`localStorage` בלבד. אין Supabase Auth.

> שנה את ה-PIN-ים של ה-seed (`1234`/`1111`/…) לפני שימוש אמיתי.

## מסכים

| מסך | תפקיד | תיאור |
|-----|--------|-------|
| **משימות** | כולם | Operator רואה רק משימות שלו שאינן `completed`; Admin רואה את כולן. כרטיס `planned` → צ'קליסט (5 סעיפים) → "התחל משימה". כרטיס `active` → "GPS פעיל" + "השלם משימה" (טופס בפועל; סטייה מהמתוכנן מחייבת סיבה). |
| **יצירה** | Admin בלבד | בחירת מוצר (מאתר מתמלא אוטומטית ממחסן-הבית, ניתן לשינוי), יעד (ברירת מחדל `S07`), עובד, קוד רכב, ציר, חלון זמן. |
| **היסטוריה** | כולם | משימות שהושלמו — Planned מול Actual זה מול זה (סטיות מודגשות), עם `audit_log` מתקפל. |

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
