# AC Remote

A small web app for controlling an AUX / AC Freedom air conditioner from your phone or laptop. It runs on Cloudflare Workers and talks to the AC Freedom cloud using your existing account, so you can keep using the official app as well.

- `src/aux.js`: AC Freedom cloud client (login, device list, read/set settings)
- `src/index.js`: Worker API with passcode sign-in
- `public/`: phone-friendly control page (can be added to your home screen)

Your AC Freedom email and password are stored as encrypted Cloudflare secrets. They never reach the browser.

## Deploy

1. Install dependencies and log in to Cloudflare (a free account is enough):
   ```bash
   npm install
   npx wrangler login
   ```
2. Set the secrets. Each command prompts for the value:
   ```bash
   npx wrangler secret put AUX_EMAIL      # your AC Freedom login email
   npx wrangler secret put AUX_PASSWORD   # your AC Freedom password
   npx wrangler secret put APP_PASSCODE   # a number-only passcode (6+ digits) for opening this web app
   ```
   Optional: `AUX_REGION` (`eu`, `usa`, `rus` or `cn`). If you leave it unset, the app tries each region in turn.
3. Deploy:
   ```bash
   npx wrangler deploy
   ```
   Open the `https://ac-remote.<your-subdomain>.workers.dev` URL it prints, enter your passcode, and you're in. You stay signed in for 30 days per device.

On iPhone: Safari → Share → **Add to Home Screen** for an app-like icon.

## Test locally first (optional)

```bash
cp .dev.vars.example .dev.vars   # then fill in your real values
npx wrangler dev
```
Open http://localhost:8787.

## Notes

- Only email-based AC Freedom accounts are supported, not phone-number logins.
- AC Freedom has no official API. This app uses the same calls the mobile app makes, as documented by the open-source ha-aux-cloud project. AUX could change them at any time.
- Extra security: you can put the Worker behind Cloudflare Access (Zero Trust → Access → Applications) to add email-code login on top of the passcode.
- Changing `APP_PASSCODE` signs out every device.

## Schedules

Tap **Add** under Schedules to make the AC turn on (with a mode, temperature and fan speed) or turn off at a set time, either once or on chosen days. Schedules are stored in your Cloudflare Worker (in a Durable Object), and a trigger checks every minute and runs any that are due, even when the app is closed.

These are separate from the "booking" timers in the AC Freedom app. AUX hasn't published how bookings work, so this app can't read or change them. If you keep both, make sure they don't conflict.

If a schedule can't reach your AC (for example the AC is offline), the app shows "Last run failed" under it.
