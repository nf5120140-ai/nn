# מחסן המטבח - הוראות פריסה

## שלב 1: וודא שהטבלה קיימת ב-Supabase
הרץ בעורך ה-SQL של Supabase (אם עוד לא הרצת):

```sql
create table kv_store (
  key text not null,
  shared boolean not null default true,
  value jsonb not null,
  updated_at timestamptz default now(),
  primary key (key, shared)
);
alter table kv_store enable row level security;
create policy "allow all" on kv_store for all using (true) with check (true);
```

## שלב 2: העלה ל-GitHub
1. צור repository חדש בשם warehouse-app ב-github.com
2. גרור את כל הקבצים מהתיקייה הזו (חוץ מ-README) לתוך הדפדפן בעמוד ה-repo (Add file > Upload files)
3. Commit

## שלב 3: פרוס ב-Vercel
1. היכנס ל-vercel.com עם חשבון GitHub
2. New Project > ייבא את warehouse-app
3. Vercel יזהה אוטומטית שזה Vite - פשוט לחץ Deploy
4. תוך דקה תקבל כתובת אתר קבועה

## התחברות ראשונה
משתמש: מנהל | סיסמה: 1234
