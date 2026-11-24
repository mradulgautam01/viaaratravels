# Viaara Travels â€” Project & Deployment Handover

**Document date:** 22 November 2026
**Repository:** `https://github.com/mradulgautam01/viaaratravels`
**Production URL:** <https://viaaratravels.com>
**Production branch:** `reliability-hardening`

---

## 1. Executive summary

Viaara Travels is deployed on AWS and serving the production site from an EC2-hosted Node.js/Express application behind Nginx. Production uses PostgreSQL for application data and S3 for uploaded media, with CloudFront configured for media delivery. The production environment was verified healthy during the 22 November deployment sequence.

Recent changes delivered:

1. Added a dedicated homepage hero poster image.
2. Kept the hero video for desktop only; mobile keeps the poster and does not request the MP4.
3. Added a Technical Partner attribution for T3 AI Solution in the footer, including website and email links.
4. Increased the enquiry auto-popup delay from 6 seconds to 15 seconds.
5. Pushed both releases to GitHub and pulled them onto EC2.

The latest known production commit is **`5ec5b80` â€” `Increase enquiry popup delay to 15 seconds`**.

## 2. Architecture and environments

| Area | Configuration |
|---|---|
| Application | Node.js / Express |
| Production host | AWS EC2, Ubuntu |
| Production application directory | `/var/www/viaara` |
| Process manager | PM2; application process name `viaara` |
| Web server / reverse proxy | Nginx |
| Domain | `viaaratravels.com` |
| AWS region | `ap-south-1` (Mumbai) |
| Production database | PostgreSQL; database `viaara_db`; local host/port `localhost:5432` |
| Local development database | SQLite (`DB_CLIENT=sqlite`) |
| Production database setting | `DB_CLIENT=postgres` |
| Media storage | Amazon S3 |
| S3 bucket | `viaara-travel-images-807593376390-ap-south-1-an` |
| CloudFront hostname | `dtftq47mw2hqk.cloudfront.net` |
| EC2 IAM role | `viaara-s3-ec2-role` |
| Production environment file | `/var/www/viaara/.env` (keep private; do not commit or overwrite) |
| Git branch | `reliability-hardening` |

The production application has been observed reporting `DB: postgres`, `Storage: s3`, and `Env: production`. S3 access through the EC2 IAM role and CloudFront media delivery were previously verified.

### Important environment separation

- Local development uses SQLite; production uses PostgreSQL.
- Production `.env`, PostgreSQL data, S3 objects, IAM configuration, and CloudFront configuration are infrastructure/runtime assets. A normal code deployment must not overwrite or reset them.
- Database migrations are separate operational tasks. Do not run migrations automatically just because a front-end or small application code change is deployed.

## 3. Production data and database import history

The production database was intentionally aligned with the local SQLite data during the initial production setup. The import was performed transactionally using a temporary SQLite export/import workflow on EC2.

The imported data counts recorded after the successful import were:

| Table | Imported rows |
|---|---:|
| `trips` | 5 |
| `departures` | 14 |
| `departure_groups` | 14 |
| `departure_sequences` | 15 |
| `bookings` | 0 |
| `trip_instances` | 0 |
| `leads` | 1 |
| `analytics` | 0 |
| `app_sessions` | 0 |
| `testimonials` | 0 |

The five trip records were Chopta Tungnath, Manali & Kasol, McLeod Ganj & Triund, Spiti Valley Winter Expedition, and Udaipur & Mount Abu. Production `trips.summary` was widened to `TEXT` before the successful import because local summaries exceeded the original production column width.

**Operational warning:** The import workflow truncated and replaced application data tables. It was a one-time alignment operation, not a routine deployment step. Never repeat it without an explicit data migration plan and a verified backup.

## 4. Homepage hero poster and video behavior

### Implementation

Files and assets:

- `public/index.html`
- `public/media/hero-poster.png`
- Existing video: `/media/hero-varanasi.mp4`
- Previous poster/background: `/media/hero-varanasi.jpg`

The selected still image was copied unchanged from the local source file `D:\Projects\Viaara Travels\Videos\hero poster.png` to `public/media/hero-poster.png`. SHA-256 hashes of the source and copied file were checked and matched.

Poster dimensions recorded before copying: **1912 Ã— 801**. File size on the production server: **3,139,417 bytes (~3.14 MB)**. It is a PNG and is currently served directly from the application via Nginx/Express.

The CSS hero background and the video element's `poster` attribute now both reference `/media/hero-poster.png`.

### Responsive behavior

The JavaScript checks:

```js
window.matchMedia('(min-width:1101px)').matches
```

The video element does not contain a static MP4 `src` in the HTML. JavaScript assigns `/media/hero-varanasi.mp4` only when the viewport is at least 1101px and the user has not requested reduced motion. Consequently:

- **Desktop (1101px and wider):** poster is visible first; the hero video is then loaded and played when allowed.
- **Mobile (up to 1100px):** poster remains permanently; the MP4 source is not assigned, so the browser should not request the video.
- **Reduced-motion preference:** the poster remains and the video is not loaded.

### Testing performed

- Desktop browser test: poster appeared and video subsequently played.
- Mobile emulation at 430px: an initial test appeared to show video, but the page had been loaded at desktop width before switching the device toolbar. A hard reload with mobile width selected and cache disabled confirmed the poster stayed visible and no MP4 request occurred.
- Tablet testing was explicitly deferred and was not completed.
- Production poster URL returned HTTP 200 with `Content-Type: image/png` and `Content-Length: 3139417`.
- Production homepage HTML was checked and contained the new poster references and 1101px breakpoint.

## 5. Footer Technical Partner attribution

The homepage footer now includes:

- Label: `TECHNICAL PARTNER`
- Company name: **T3 AI Solution**
- Website: `https://www.t3aisolution.com/`
- Email: `info@t3aisolution.com` (linked using `mailto:`)

The company name and email links were manually checked in the browser. Production HTML was also checked and contained both links.

## 6. Enquiry auto-popup timing change

In `public/index.html`, the enquiry auto-popup delay was increased from **6 seconds** to **15 seconds**.

The session-level behavior remains: the popup is shown once per session, and the existing guard avoids opening it if another modal/overlay is already open. The only intended code change in the latest commit was the comment and timeout value (`6000` â†’ `15000`).

## 7. Git and deployment history

Repository branch: `reliability-hardening`.

| Commit | Description | Deployment status |
|---|---|---|
| `55d1592` | Add optimized hero loading and technical partner attribution | Pushed to GitHub and pulled onto EC2 on 22 Nov 2026 |
| `5ec5b80` | Increase enquiry popup delay to 15 seconds | Pushed to GitHub and pulled onto EC2 on 22 Nov 2026 |

The `55d1592` release added the hero poster asset and updated the homepage hero/footer. The `5ec5b80` release changed the enquiry popup delay.

### Local untracked file

The local working tree showed an untracked file:

```text
db/migrate.js.pre-fix
```

It was intentionally not staged or committed during either release. Leave it untracked unless its purpose is reviewed and a deliberate decision is made to retain, archive, or remove it.

## 8. Deployment procedure used

### Local Windows / PowerShell

From the local repository:

```powershell
cd "D:\Projects\Viaara Travels\viaaratravels"
git status --short
git diff --stat
git diff
```

Stage only the intended files, commit, and push:

```powershell
git add <specific-file-paths>
git diff --cached --stat
git commit -m "<clear change description>"
git push origin reliability-hardening
```

Do not use `git add .` blindly. Check that `db/migrate.js.pre-fix`, `.env`, local databases, generated files, and unrelated changes are not included.

### Production EC2 / Ubuntu

```bash
cd /var/www/viaara
git status --short
git branch --show-current
git pull origin reliability-hardening
git log -1 --oneline
```

For the recent static HTML/asset changes, the application was restarted using:

```bash
pm2 restart viaara --update-env
pm2 status
```

Health check:

```bash
curl -sS https://viaaratravels.com/api/health
```

Expected healthy response includes:

```json
{"status":"ok","env":"production","db":"postgres","storage":"s3"}
```

For static file verification:

```bash
curl -I https://viaaratravels.com/media/hero-poster.png
curl -s https://viaaratravels.com/ | grep -E 'hero-poster|1101px|T3 AI Solution|info@t3aisolution.com'
```

### Important note about the latest restart

After pulling commit `5ec5b80`, PM2 showed the `viaara` process as `online`, but the first external health request returned an Nginx **502 Bad Gateway**. The user subsequently indicated the issue was handled. No diagnostic output confirming the final recovery was captured in this handover, so the current health state should be rechecked if there is any doubt:

```bash
curl -i http://127.0.0.1:3000/api/health
curl -i https://viaaratravels.com/api/health
pm2 status
pm2 logs viaara --lines 60 --nostream
```

Do not infer that PM2 `online` alone guarantees that the app is responding. Confirm both the local upstream and public health endpoint.

## 9. Near-future recommendations

Prioritized recommendations based on the current implementation and the observed production behavior.

### Priority 1 â€” Improve static asset delivery

1. **Create a WebP version of the hero poster.** The current PNG is ~3.14 MB. Generate a visually checked WebP derivative while keeping the original PNG unchanged until the replacement is approved. A practical initial target is roughly 200â€“300 KB, but visual quality takes priority over hitting a strict file size.
2. **Set long-lived cache headers for fingerprinted/versioned static assets.** The poster currently responds with `Cache-Control: public, max-age=0`. Consider versioned filenames or a content-hash strategy before applying immutable caching, so updated assets are not trapped in browser caches.
3. **Keep the mobile video non-loading guarantee.** Test with a fresh reload at mobile width and inspect the Network tab for zero requests to `hero-varanasi.mp4`. Consider adding an automated browser test for this requirement.
4. **Test tablet behavior when convenient.** The current code intentionally treats all widths below 1101px like mobile. Tablet testing was deferred, not passed.

### Priority 2 â€” Optimize all admin-uploaded images

Implement server-side image processing in the upload pipeline:

- Validate file type and size; do not trust the filename or browser-provided MIME type alone.
- Resize large images to sensible maximum dimensions for their display context.
- Generate modern formats such as WebP where supported, with an appropriate fallback strategy if required.
- Preserve aspect ratio and avoid upscaling small images.
- Generate thumbnails/variants for cards and detail pages rather than serving full-resolution originals everywhere.
- Store the processed assets in the existing S3 bucket and continue returning CloudFront URLs to the application.
- Keep originals only if there is a clear operational/business need; define retention and storage rules deliberately.
- Test orientation, transparency, animated formats, corrupt files, and upload failure handling.

This should be implemented and tested as a separate change, not bundled into a small homepage release.

### Priority 3 â€” Make deployment more resilient

- Investigate the transient 502 after PM2 restart and confirm whether the application startup time or readiness behavior caused it.
- Add a deployment health gate: after restart, poll the local health endpoint and public endpoint with a bounded retry window; report failure and stop rather than treating PM2 `online` as sufficient.
- Review the existing `deploy.sh` before changing it. A previously reviewed deployment flow used clean-working-tree validation, `git pull --ff-only`, `npm ci --omit=dev`, and `pm2 restart viaara --update-env`. Confirm the current script matches the repository's actual production needs before relying on it.
- Consider a graceful reload or blue/green strategy if restart-related 502s recur.
- Keep database migrations explicit and separately approved. Do not automatically run destructive or data-changing scripts as part of every deploy.

### Priority 4 â€” Add lightweight production monitoring

- Monitor `/api/health` and alert on repeated failures.
- Track PM2 restarts, process memory, CPU, and application error logs.
- Monitor Nginx 5xx responses and upstream connection failures.
- Track S3/CloudFront response status and asset cache behavior.
- Review backup/restore procedures for PostgreSQL and S3 lifecycle/retention policies.

### Priority 5 â€” Finalize homepage behavior and content checks

- Test enquiry popup timing on desktop and mobile: it should appear after 15 seconds, only once per session, and not over another open modal.
- Confirm the footer attribution remains readable at narrow widths and does not overlap existing footer content.
- Complete the deferred tablet hero test.
- Consider a small automated smoke-test checklist for homepage load, poster response, no mobile MP4 request, enquiry popup, and footer links.

## 10. Operational safety checklist

Before each future release:

- [ ] Confirm local branch is `reliability-hardening`.
- [ ] Review `git status`, `git diff`, and staged diff.
- [ ] Stage only the files intended for the release.
- [ ] Confirm `.env`, database files, secrets, and backup files are excluded.
- [ ] Run relevant local checks and test the changed behavior.
- [ ] Commit and push the intended commit.
- [ ] On EC2, verify branch and working-tree status before pulling.
- [ ] Pull with fast-forward behavior; do not overwrite unexplained production changes.
- [ ] Restart/reload only when appropriate.
- [ ] Verify PM2, local health endpoint, public health endpoint, and changed feature.
- [ ] Check logs if any 5xx response appears.
- [ ] Do not run database imports or migrations unless the release specifically requires them and the migration plan is reviewed.

---

## 11. Current known state at handover

- Latest known deployed commit: `5ec5b80` on `reliability-hardening`.
- Hero poster: deployed at `/media/hero-poster.png`; direct production request previously returned HTTP 200.
- Desktop hero video: loads only at widths of 1101px or greater, subject to reduced-motion preference.
- Mobile hero: poster remains; fresh mobile-width reload confirmed no MP4 request.
- Tablet behavior: not tested.
- Footer: T3 AI Solution website and email links implemented and verified in production HTML; user manually checked that they are clickable.
- Enquiry popup: delay changed to 15 seconds and commit deployed.
- Production: a transient 502 was observed immediately after the latest PM2 restart; user subsequently reported the issue handled, but the final successful health response is not included in the captured logs.
- Local untracked backup: `db/migrate.js.pre-fix`; intentionally excluded from commits.
