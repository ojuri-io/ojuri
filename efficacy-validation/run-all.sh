#!/usr/bin/env bash
# Reproduces every efficacy-validation scenario end-to-end against the
# unmodified `docker compose up` stack.
#
# Exit 0  = harness completed every scenario (Ojuri's verdicts, good or bad,
#           are findings for report.md -- never a failure).
# Exit !=0 = harness failure (stack unreachable, non-200 predict, etc).
#
# Total wall time on the reference workstation: ~2.5 hours, dominated by
# Track 1 PAA-flush barriers and Track 4 real-time observation windows.
set -uo pipefail
cd "$(dirname "$0")"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%S)}"
RPS="${RPS:-20}"

echo "== efficacy-validation run ${RUN_ID} =="

( cd .. && docker compose up -d --build ) || exit 3

echo "-- waiting for RDA (via NGINX) and PAA readiness"
for i in $(seq 1 120); do
  curl -sf http://localhost:80/ready >/dev/null && break
  sleep 2
  [ "$i" = 120 ] && { echo "RDA never became ready" >&2; exit 3; }
done
for i in $(seq 1 60); do
  curl -sf http://localhost:9091/readyz >/dev/null && break
  sleep 2
  [ "$i" = 60 ] && { echo "PAA never became ready" >&2; exit 3; }
done

SCENARIOS=(
  scenarios/track1_mobile_money_ring.py
  scenarios/track1_mule_network.py
  scenarios/track1_card_testing.py
  scenarios/track1_structuring.py
  scenarios/track1_sim_swap_ato.py
  scenarios/track1_shared_device.py
  scenarios/track1_velocity_burst.py
  scenarios/track2_agent_fanout.py
  scenarios/track2_payroll.py
  scenarios/track2_diaspora_remittance.py
  scenarios/track2_airtime_topups.py
  scenarios/track3_indist.py
  scenarios/track3_shift_amounts.py
  scenarios/track3_shift_mix_time.py
  scenarios/track4_ring5.py
  scenarios/track4_ring8_dense.py
  scenarios/track4_community_stability.py
)

for s in "${SCENARIOS[@]}"; do
  echo "== running ${s}"
  python3 harness/runner.py --scenario "$s" --run-id "$RUN_ID" --rps "$RPS" \
    > "results/$(basename "$s" .py).stdout.json" || exit $?
done

echo "== all scenarios complete; metrics under results/<scenario>/metrics.json"
