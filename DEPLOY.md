# Deploying UniTickets (free tiers)

**Setup:** Vercel (app and pages), Neon (database), Cloudflare R2 (file uploads and backups), Resend (email), Cloudflare Turnstile (CAPTCHA). Allow about an hour the first time.

```
Phone ──HTTPS──> Vercel (fra1, Frankfurt)
                 ├─ public/ pages ........ served by Vercel's CDN
                 ├─ /api/* ............... one serverless function (Express)
                 └─ daily cron 07:00 ..... escalations, reminders, retries, clean-up
                        │
                        ├──> Neon Postgres (AWS Frankfurt)
                        ├──> Cloudflare R2 (private bucket, attachments)
                        ├──> Resend (email)
                        └──> Cloudflare Turnstile (CAPTCHA check)
GitHub Actions (nightly) ──pg_dump──> R2 backup bucket
```

## Which options and why

**Database: Neon (recommended) over Supabase.**

| | Neon free | Supabase free |
|---|---|---|
| Storage | 1 GB per project ([Neon FAQ](https://neon.com/faqs/free-plan-limits-and-quotas)) | 500 MB |
| Inactivity | Compute sleeps after a few idle minutes and wakes on the next request (a short delay, no action needed) | **Whole project pauses after a week of low activity**, and you must restore it by hand ([Supabase KB](https://supabase.com/kb/faqs/platform/free-project-pausing)) |
| Fit for this app | Plain Postgres, which is all this app uses | Its built-in login and storage would go unused (this app has its own login, and files go to R2) |
| With Vercel | Listed in the Vercel Marketplace | Works, but its pooler certificate needs an extra SSL setting with the `pg` driver |

During user testing there will be quiet weeks, and a helpdesk that silently pauses is the worst outcome. That's the deciding point. The code works with both, because it only needs a standard `DATABASE_URL`. Supabase notes are at the end.

**Hosting: Vercel only, not Cloudflare Pages as well.** Splitting the pages (Pages) from the API (Vercel) would put them on different domains. Then the staff login cookie, which is deliberately limited to its own site, would stop working, and a CORS setup would be needed. One host means one domain, one deploy and fewer settings to get wrong. Cloudflare is still used for R2, Turnstile, and optionally your domain's DNS.

**Limits to know (check the providers' pages; free tiers change):**
- **Vercel Hobby:** scheduled jobs can run only **once a day**, and the start time can vary within the hour ([Vercel docs](https://vercel.com/docs/cron-jobs/usage-and-pricing)). That's fine here: escalation is counted in whole working days, so the job runs every morning at about 07:00 Lusaka time. Hobby is also meant for personal, non-commercial use. A university running this for real should move to Vercel Pro; user testing is the time to decide.
- **Resend free:** about 3,000 emails a month and 100 a day. Enough for testing; watch it if many students consent.
- **R2 free:** 10 GB of storage, with no fees for downloads.
- **Data location:** everything sits in Frankfurt (Germany). Zambia's Data Protection Act has rules on keeping personal data outside Zambia. Confirm with the university's data protection officer before real student data goes in.

---

## Step 1: Put the code on GitHub

1. Create a **private** repository on GitHub, e.g. `unitickets`.
2. In the UniTickets folder:
   ```bash
   git init
   ```
   ```bash
   git add . && git commit -m "UniTickets"
   ```
   ```bash
   git branch -M main && git remote add origin https://github.com/<you>/unitickets.git && git push -u origin main
   ```
   `.gitignore` already keeps `.env`, `data/` and `node_modules/` out of the repository.

## Step 2: Neon database

1. Sign up at [neon.com](https://neon.com) and create a project.
   - **Region:** AWS Europe Central (Frankfurt), to match Vercel's `fra1`.
   - **Postgres version:** note it (e.g. 17). The backup job uses the same version (`postgres:17` in `.github/workflows/backup.yml`); change that number if yours differs.
2. Click **Connect** and copy two connection strings:
   - **Pooled** (the host contains `-pooler`): this is `DATABASE_URL` for Vercel.
   - **Direct** (turn "Connection pooling" off): this is `DATABASE_URL_DIRECT` for backups.
3. Keep both private. They contain the database password.

## Step 3: Generate the secrets

Run this twice, once for `APP_SECRET` and once for `CRON_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 4: Cloudflare R2 (uploads and backups)

1. In the Cloudflare dashboard go to **R2 Object Storage** (it asks for a card even on the free plan) and create two buckets:
   - `unitickets-uploads`
   - `unitickets-backups`

   Leave **public access off** on both. Files are only handed out by the app after a staff login check.
2. On `unitickets-backups`, go to **Settings → Object lifecycle rules** and delete objects after 30 days.
3. **R2 → Manage API tokens → Create API token**, twice:
   - Token 1: **Object Read & Write**, limited to `unitickets-uploads`. This gives `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` for Vercel.
   - Token 2: **Object Read & Write**, limited to `unitickets-backups`. This is for GitHub backups only.

   The app's token can't read the backups, so a leak of one doesn't expose the whole database.
4. Note your **Account ID** (shown on the R2 overview page). That's `R2_ACCOUNT_ID`.

## Step 5: Cloudflare Turnstile (CAPTCHA)

1. Cloudflare dashboard → **Turnstile → Add widget**.
2. **Hostnames:** your Vercel address (e.g. `unitickets.vercel.app`) and your own domain if you add one later.
3. **Widget mode:** Managed.
4. Copy the **Site key** (`TURNSTILE_SITE_KEY`) and **Secret key** (`TURNSTILE_SECRET_KEY`).

## Step 6: Resend (email)

1. Sign up at [resend.com](https://resend.com).
2. **Domains → Add domain**, e.g. `chresonline.com` or a subdomain such as `mail.chresonline.com`. Add the DNS records Resend shows (if the domain's DNS is on Cloudflare, it can add them in one click) and wait for **Verified**.

   Without a verified domain, Resend only sends to your own address, so students would get nothing.
3. **API Keys → Create API key** with **Sending access**. This is `RESEND_API_KEY`.
4. Choose the sender address, e.g. `MAIL_FROM=UniTickets IT Helpdesk <helpdesk@chresonline.com>`.

## Step 7: Vercel

1. Sign up at [vercel.com](https://vercel.com) with GitHub. **Add New → Project →** import `unitickets`.
2. **Framework Preset:** Other. Leave the build settings alone; `vercel.json` sets them.
3. Open **Environment Variables** and add all of these for **Production** (and **Preview** if you'll use preview deployments):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** connection string |
   | `BASE_URL` | `https://<your-project>.vercel.app` (update it if you add a domain) |
   | `APP_SECRET` | secret 1 from step 3 |
   | `CRON_SECRET` | secret 2 from step 3 |
   | `RESEND_API_KEY` | from step 6 |
   | `MAIL_FROM` | from step 6 |
   | `TURNSTILE_SITE_KEY` | from step 5 |
   | `TURNSTILE_SECRET_KEY` | from step 5 |
   | `R2_ACCOUNT_ID` | from step 4 |
   | `R2_ACCESS_KEY_ID` | token 1 from step 4 |
   | `R2_SECRET_ACCESS_KEY` | token 1 from step 4 |
   | `R2_BUCKET` | `unitickets-uploads` |

4. Click **Deploy**. The build runs `scripts/setup-db.js`, which creates the tables in Neon. If a required setting is missing, the app refuses to start and the function log names what's missing.
5. Check **Settings → Functions → Region** shows Frankfurt (`fra1`), and **Settings → Cron Jobs** lists `/api/cron` daily.

## Step 8: Create the first admin (in Neon)

The admin made earlier lived in the old local database and does not carry over. On your PC, in the UniTickets folder:

1. Create a file named `.env` (copy `.env.example`) and set only:
   ```
   DATABASE_URL=<Neon pooled connection string>
   ```
2. Run:
   ```bash
   npm run create-user -- CU411 "SUDO ADMIN" admin@chresonline.com admin
   ```
   It prints a temporary password that is shown once.
3. Open `https://<your-project>.vercel.app/staff.html`, sign in, scan the 2FA QR code, and set a new password.
4. In the **Users** tab, add a **second admin** straight away.
5. In **Settings**, set the real department emails and check the holiday list.

If an admin is ever locked out (lost phone), run this from your PC with the same `.env`:
```bash
npm run reset-user -- IT-CU411 2fa
```

## Step 9: Nightly backups (GitHub Actions)

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `DATABASE_URL_DIRECT` | Neon **direct** connection string |
| `R2_ACCOUNT_ID` | from step 4 |
| `R2_BACKUP_ACCESS_KEY_ID` | token 2 from step 4 |
| `R2_BACKUP_SECRET_ACCESS_KEY` | token 2 from step 4 |
| `R2_BACKUP_BUCKET` | `unitickets-backups` |

Then **Actions → Nightly database backup → Run workflow** once, and check that a `helpdesk-YYYY-MM-DD.dump` file appears in the bucket.

**To restore:** download a dump, then run `pg_restore --clean --no-owner -d "<direct connection string>" helpdesk-YYYY-MM-DD.dump`. Try it once on a spare Neon branch, so you know it works before you need it.

## Step 10: Check the live site

- [ ] `https://<project>.vercel.app/` shows the QR code. Scan it with a phone: the form opens.
- [ ] Submit a ticket with consent YES using your own email: the ticket email arrives (check spam the first time).
- [ ] Submit one with consent NO: it shows "Untracked", and no email is sent.
- [ ] Upload a small screenshot, then download it from the staff dashboard.
- [ ] The Turnstile check appears on step 2 (often just a tick, no puzzle).
- [ ] Refer a ticket to a department using your own email as that department's address. Open the link, confirm, and click **Issue Resolved**.
- [ ] Vercel → **Settings → Cron Jobs → Run** on `/api/cron`: it returns `"ok"` for each job.
- [ ] Sign out, wait 30 minutes, and confirm the session has ended.

**Print the QR posters only after this list passes.** The QR code contains the address of the site showing it, so print from the live site, not from your PC.

## Optional: your own domain

Vercel → **Settings → Domains → Add** (e.g. `helpdesk.chresonline.com`). Add the DNS record Vercel shows at your DNS provider (on Cloudflare, set it to **DNS only**, the grey cloud, so the two services don't both proxy). Then update `BASE_URL`, add the domain to the Turnstile hostnames, and redeploy.

## If you choose Supabase instead

- Use the **Transaction pooler** connection string (port `6543`) as `DATABASE_URL`, and the **direct** or **session** string for backups.
- Add `?sslmode=require&uselibpqcompat=true` to the end of the string. Supabase's pooler certificate is not publicly trusted, and the `pg` driver otherwise rejects it.
- Remember the free project **pauses after a week of low activity**. The daily cron touches the database every day, which may be enough to keep it awake, but Supabase doesn't guarantee that.
- Everything else in this guide stays the same.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every page works but all `/api` calls fail with 500 | A required setting is missing. Vercel → Deployments → Functions → Logs shows "Refusing to start: missing …" |
| Build fails at "Database setup failed" | `DATABASE_URL` is wrong, or not set for that environment (Production or Preview) |
| No emails arrive | Domain not verified in Resend, or `MAIL_FROM` uses a different domain. Failed sends are retried by the daily job |
| Security check never appears | The Turnstile hostname doesn't match the site address |
| "File uploads are switched off" | One of the four `R2_*` settings is missing |
| Students see "Too many attempts" | Limits are 3 tickets per student number per 10 minutes and 60 per network address per 10 minutes; raise them in `server/public-routes.js` if needed |
