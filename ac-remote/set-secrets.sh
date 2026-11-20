#!/bin/zsh
# Asks for each secret (hidden typing) and stores it on the ac-remote Worker.
# Run from this folder after `npx wrangler login`, or with CLOUDFLARE_API_TOKEN set.
cd "$(dirname "$0")" || exit 1
for name in AUX_EMAIL AUX_PASSWORD APP_PASSCODE; do
  case $name in
    AUX_EMAIL) echo ">> Your AC Freedom login EMAIL" ;;
    AUX_PASSWORD) echo ">> Your AC Freedom PASSWORD" ;;
    APP_PASSCODE) echo ">> Make up a NUMBER-ONLY passcode for the web app (6+ digits)" ;;
  esac
  npx wrangler secret put "$name" || { echo "Failed to set $name"; exit 1; }
  echo ""
done
echo "All done. Open your ac-remote workers.dev URL (shown by 'npx wrangler deploy')."
