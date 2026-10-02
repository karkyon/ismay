#!/usr/bin/env bash
# [SECURITY-RATE-02D新設・2026-10-02] ISMAYの定期health check(systemd timer: deploy/systemd/ismay-healthcheck.timer)。
# 運用: docs/runbooks/SECURITY_RATE_RUNBOOK.md §2。
#
# 同一hostからGET /api/v1/healthを呼び、degraded・応答なし・ismay-app.service停止をjournalへerror(priority err)で出す。
# alertの送り先はjournal(`journalctl -t ismay-health -p err`)。外部通知は未設定(送り先が未決のため)。
# 正常時は状態が変わったときだけinfoを出す(毎分のinfo行でjournalを埋めない)。
set -u

URL="${ISMAY_HEALTH_URL:-http://127.0.0.1:13000/api/v1/health}"
SERVICE="${ISMAY_SERVICE:-ismay-app.service}"
STATE_DIR="${STATE_DIRECTORY:-/run/ismay-healthcheck}"
STATE_FILE="${STATE_DIR}/last_status"
TAG="ismay-health"

mkdir -p "$STATE_DIR" 2>/dev/null || true
prev="$(cat "$STATE_FILE" 2>/dev/null || echo unknown)"

active="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
body="$(curl -sS --max-time 8 -w '\n%{http_code}' "$URL" 2>&1)"
code="$(printf '%s' "$body" | tail -n 1)"
json="$(printf '%s' "$body" | sed '$d' | tr -d '\n' | cut -c1-600)"

if [ "$active" != "active" ]; then
  status="service-${active:-unknown}"
elif [ "$code" = "200" ]; then
  status="ok"
elif [ "$code" = "503" ]; then
  status="degraded"
else
  status="unreachable(${code})"
fi

if [ "$status" = "ok" ]; then
  if [ "$prev" != "ok" ]; then
    logger -t "$TAG" -p user.info "ISMAY health ok (previous=${prev})"
  fi
else
  logger -t "$TAG" -p user.err "ISMAY health ${status} service=${active} http=${code} body=${json}"
fi
printf '%s' "$status" > "$STATE_FILE" 2>/dev/null || true

[ "$status" = "ok" ]
