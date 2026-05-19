#!/bin/bash
# Staggered Forecast Cron Job Setup
#
# Runs every 5 minutes. Each run processes a small batch of shops
# whose forecasts are stale (>6 hours old). All shops are naturally
# covered across the 6-hour window without thundering herd.
#
# Scalability:
#   - 10,000 shops, batch=150 → fully covered in ~5.5 hours
#   - 1,000 shops, batch=10  → fully covered in ~8 minutes
#   - Self-healing: missed shops get priority next cycle
#
# Usage: CRON_SECRET=mysecret bash scripts/setup-forecast-cron.sh

CRON_SECRET="${CRON_SECRET:-$(openssl rand -hex 16)}"
APP_URL="${SHOPIFY_APP_URL:-https://shopify-protect.onitnetworking.com}"
BATCH_SIZE="${FORECAST_BATCH_SIZE:-10}"

echo "=== Staggered Forecast Cron Setup ==="
echo "App URL:    $APP_URL"
echo "Batch Size: $BATCH_SIZE shops per run"
echo "Schedule:   Every 5 minutes"
echo "Secret:     $CRON_SECRET"
echo ""
echo "Add to .env:"
echo "  CRON_SECRET=$CRON_SECRET"
echo ""

CRON_CMD="*/5 * * * * curl -sf -H 'X-Cron-Secret: $CRON_SECRET' '$APP_URL/api/cron/forecast?batch=$BATCH_SIZE' >> /var/log/shopify-forecast-cron.log 2>&1"

# Remove existing forecast cron if present
if crontab -l 2>/dev/null | grep -q "api/cron/forecast"; then
  echo "Removing old cron entry..."
  crontab -l 2>/dev/null | grep -v "api/cron/forecast" | crontab -
fi

(crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -

echo "Installed. Verify: crontab -l"
echo "Test:    curl -H 'X-Cron-Secret: $CRON_SECRET' '$APP_URL/api/cron/forecast?batch=2'"
echo "Monitor: tail -f /var/log/shopify-forecast-cron.log"
