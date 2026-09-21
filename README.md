# OPS Dashboard

מערכת ניהול צוות אבטחה/הפעלה — מעקב אחר תנועות נכסים בין מחסנים למפעל בדיקות,
עם backend משותף ב-**Supabase** וסנכרון בזמן אמת בין כל המשתמשים.

Vite + TypeScript · vanilla DOM · RTL עברית · PWA · ערכת צבעים כהה-ענברית.

## מודל עסקי (הקשר)

- 6 מוצרים (`A1`–`A6`), לכל אחד מחסן-בית עצמאי (`S01`–`S06`).
- מפעל אחד משותף (`S07`) שאליו נעשות רוב התנועות.
- אבטחת מידע: במערכת נשמרים **רק קודים** (נכסים `A#`, אתרים `S##`, צירים Blue/Green/Red).
  המשמעות האמיתית של הקודים מנוהלת מחוץ למערכת (מסמך פיזי).

## הרצה מקומית

```bash
cp .env.example .env      # כבר מכיל את פרטי ה-Supabase הנכונים
npm install
npm run dev               # http://localhost:5173
```

`npm run build` — בדיקת טיפוסים (tsc) + build ל-`dist/`.

### משתני סביבה (`.env`)

```
VITE_SUPABASE_URL=...            # כתובת פרויקט Supabase
VITE_SUPABASE_PUBLISHABLE_KEY=... # publishable/anon key (public-safe, מוגן ב-RLS)
```

`.env` ב-`.gitignore`. הערכים נמצאים ב-`.env.example` (ה-anon key נועד להיחשף ב-client
ומוגן ע"י RLS), כך שהעתקה פשוטה מספיקה.

## הקמת ה-Database (חד-פעמי)

הרץ את `supabase/migration.sql` ב-**Supabase SQL Editor**
(Dashboard → SQL Editor → New query → Paste → Run). הקובץ:

- יוצר את הטבלאות `sites`, `assets`, `employees`, `tasks`.
- מפעיל **RLS** עם מדיניות `select`/`insert`/`update` פתוחה ל-anon key
  (מערכת פנימית סגורה) — **בלי `delete`** מה-client.
- מוסיף את `tasks` ל-publication של **Realtime**.
- טוען **seed data**: 6 מחסנים + מפעל, 6 מוצרים, ו-5 עובדים לדוגמה.

> ⚠️ עדכן את ה-PIN-ים של העובדים ב-seed (`1234`/`1111`/…) לפני שימוש אמיתי.

הקובץ idempotent — אפשר להריץ שוב בבטחה.

## התחברות

בלי Supabase Auth. מסך הכניסה טוען את רשימת העובדים, בוחרים שם ומזינים **PIN בן 4 ספרות**;
המערכת מאמתת מול טבלת `employees` ושומרת session ב-`localStorage`.

עובדי seed לדוגמה: `מנהל` (admin, PIN `1234`), `עובד 1`–`עובד 4` (operator, PIN `1111`–`4444`).

## מסכים

| מסך | תפקיד | תיאור |
|-----|--------|-------|
| **משימות** | כולם | Operator רואה רק משימות שלו שאינן `completed`; Admin רואה את כולן. כרטיס `planned` → צ'קליסט (5 סעיפים) → "התחל משימה". כרטיס `active` → "GPS פעיל" + "השלם משימה" (טופס בפועל; סטייה מהמתוכנן מחייבת סיבה). |
| **יצירה** | Admin בלבד | בחירת מוצר (מאתר מתמלא אוטומטית ממחסן-הבית, ניתן לשינוי), יעד (ברירת מחדל `S07`), עובד, קוד רכב, ציר, חלון זמן. |
| **היסטוריה** | כולם | משימות שהושלמו — Planned מול Actual זה מול זה (סטיות מודגשות), עם `audit_log` מתקפל. |

## סנכרון בזמן אמת

מנוי Supabase Realtime (`postgres_changes`) על טבלת `tasks` — כל שינוי
סטטוס/checklist/actual מופיע אצל כל המשתמשים בלי refresh ידני.

## מבנה

```
supabase/migration.sql   ← הרץ ב-Supabase SQL Editor
index.html · public/     ← shell + manifest.json + icon.svg + sw.js (PWA)
src/
  main.ts                ← bootstrap, routing, מעטפת
  store.ts               ← state + מנוי realtime
  ui.ts                  ← רכיבי תצוגה משותפים (קודים/סטטוס)
  utils/                 ← supabase client, db access, session, types, constants
  screens/               ← login · tasks · create · history
  components/nav.ts      ← ניווט תחתון לפי role
```

## מה עדיין לא נבנה (בכוונה)

מסכי ניהול ישויות (assets/sites/routes/vehicles), GPS אמיתי, Pattern Matching,
Learning Dashboard, תוכנית שבועית/מנוע המלצות, deploy — כולם שלבים מאוחרים יותר.
