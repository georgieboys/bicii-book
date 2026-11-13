#!/usr/bin/env bash
# Runs the Admin's dev server against the LOCAL Supabase stack started with
# `npx supabase@2.119.0 start` (RUNBOOK "Local Supabase with Docker"),
# whatever .env.local says. Variables set here win over .env.local (Next
# never overrides a variable already in the environment), and every live
# integration is blanked so nothing reaches Shopify, Stripe or Resend.
set -euo pipefail
cd "$(dirname "$0")/.."
eval "$(npx --yes supabase@2.119.0 status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export NEXT_PUBLIC_PUBLIC_SITE_URL="http://localhost:4000"
export ADMIN_ORIGIN="http://localhost:${PORT:-3001}"
export SHOPIFY_SHOP_DOMAIN="" SHOPIFY_CLIENT_ID="" SHOPIFY_CLIENT_SECRET="" SHOPIFY_ADMIN_TOKEN=""
export SHOPIFY_WEBHOOK_SECRET="" SHOPIFY_ADAPTER="fake" CRON_SECRET=""
export STRIPE_SECRET_KEY="" STRIPE_WEBHOOK_SECRET="whsec_local_test_only" STRIPE_ADAPTER="fake"
export RESEND_API_KEY="" EMAIL_FROM=""
exec npx next dev -p "${PORT:-3001}"
