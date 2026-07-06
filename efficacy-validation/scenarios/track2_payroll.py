"""Track 2 (all legitimate): bulk payroll. Three corporate accounts disburse
salaries to ~80 employees each in a tight window (N45k-N250k), then employees
cash out. Bulk same-source disbursement is the classic structuring
false-positive shape; salaries above N100k directly probe the demo DENY rule."""

import random

from scenarios import common

NAME = "track2_payroll"
PREFIX = "t2pay"
SEED = 202
NOTES = "Zero fraud by construction. Salary distribution: N45k-N250k."

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 240)
    start = anchor_ms - DAY

    corps = [{"id": f"ev1u-{PREFIX}-{run_id}-corp{i}", "account_age_days": rng.randint(400, 3000),
              "wallet_balance": 50_000_000.0, "channel": "WEB"} for i in range(3)]

    events = []
    seq = 0
    employees = []
    for corp in corps:
        t = start + 9 * HOUR + rng.randint(0, 2 * HOUR)
        for _ in range(80):
            emp = pool.pick()
            employees.append(emp)
            salary = round(rng.lognormvariate(11.4, 0.45), 2)
            salary = min(max(salary, 45_000), 250_000)
            body = common.base_body(rng, corp, emp["id"], salary, "TRANSFER",
                                    t, run_id, PREFIX, seq)
            body["customer_type"] = "CORPORATE"
            body["is_recurring"] = True
            events.append(common.event(body, fraud=False, role="payroll_disbursement",
                                       barrier=(seq % 80 == 0)))
            seq += 1
            t += rng.randint(2, 20) * 1000

    for emp in rng.sample(employees, 120):
        ts = common.business_hour_ts(rng, start) + rng.randint(3, 10) * HOUR
        ts = min(ts, anchor_ms - 1)
        body = common.base_body(rng, emp, f"ev1u-{PREFIX}-{run_id}-cashpoint",
                                round(rng.uniform(10_000, 50_000), 2), "CASH_OUT",
                                ts, run_id, PREFIX, seq)
        events.append(common.event(body, fraud=False, role="salary_cash_out"))
        seq += 1

    return common.sort_stream(events)
