# Budgets & cost alerts

GATEKeeper can email you when AWS spend trends past a threshold. It uses **AWS Budgets**
(region-agnostic and free — unlike a CloudWatch billing alarm) in **two layers**:

1. **Per-stack budget** — one per game stack (`GateStack-AbioticFactor`, `GateStack-Valheim`, …),
   scoped to *only that stack's resources*. Default **$13/mo**.
2. **Account-wide budget** — a single budget for the *whole account's* total, including spend that
   doesn't belong to any stack (the domain renewal, tax, and any other projects in the account).
   Default **$30/mo**. Created by the **default game's stack only**, so you get one copy, not an
   identical clone per stack.

Both fire at **80% of actual spend** and on a **forecast to exceed 100%**, so a runaway (e.g. an
instance stuck on) is caught early.

## Turn it on

It's opt-in. In `.env`:

```sh
BILLING_ALERT_EMAIL=you@example.com   # required — no email, no budgets
BILLING_BUDGET_USD=30                 # account-wide total (optional, default 30)
STACK_BUDGET_USD=13                   # per-stack limit (optional, default 13)
```

Then deploy. **Deploy every game stack** so each gets its per-stack budget:

```sh
GAME=abiotic-factor npm run deploy    # per-stack budget + the account-wide budget
GAME=valheim        npm run deploy    # per-stack budget
```

You'll get an email per budget subscription asking to **confirm the SNS-style subscription** the
first time — accept it, or alerts won't arrive.

## ⚠️ One-time manual step: activate the cost-allocation tag

The per-stack budgets filter on the `aws:cloudformation:stack-name` tag, which CloudFormation
already stamps on every resource. But a tag isn't usable for billing until it's **activated as a
cost-allocation tag** — and that is an **account-level billing setting that cannot be deployed via
CDK** (there is no CloudFormation resource for it). Do it once:

```sh
aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status TagKey=aws:cloudformation:stack-name,Status=Active
```

…or in the console: **Billing → Cost allocation tags → check `aws:cloudformation:stack-name` →
Activate**.

Until you do this, a per-stack budget filter matches nothing and the budget reads **$0**.

> **Why this tag?** It's auto-applied by CloudFormation, so resources are already labeled — no
> redeploy needed to tag them, and other CDK projects in the account (e.g. another bot's stack) get
> their own per-stack line for free. A custom `Project` tag would also work but would require a
> redeploy to label resources before activation.

## Seeing per-stack spend

Once the tag is active, AWS Cost Explorer can **group by** `aws:cloudformation:stack-name`:

```sh
aws ce get-cost-and-usage \
  --time-period Start=2026-07-01,End=2026-08-01 --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=TAG,Key=aws:cloudformation:stack-name
```

## Caveats (read these before trusting the numbers)

- **Not retroactive.** Cost-allocation data starts accruing the day you activate the tag (and takes
  ~24h to populate). Spend from before activation stays lumped under an empty/untagged bucket.
- **Some costs can't belong to a stack.** Domain registration, taxes, and a manually-created hosted
  zone aren't CloudFormation resources, so they show as **untagged** — they land in the
  account-wide budget only. Your per-stack budgets will therefore **not** sum to the account total.
  That's expected.
- **A domain renewal is a once-a-year lump.** A `.net`/`.com` renewal (~$15–20) hits one month and
  can trip the account-wide budget on its own. Set `BILLING_BUDGET_USD` above your normal monthly
  total *plus* that annual spike, or just expect one noisy month a year.

## "Why did I get multiple identical budget emails?"

Older versions created the budget **per stack with no cost filter**, so every stack had its own copy
of the *same account-wide* budget — and they all fired at once when the account crossed the line
(N stacks → N emails). The two-layer design above fixes that: per-stack budgets are now filtered to
their own resources, and there's exactly one account-wide budget. If you still have leftover
unfiltered budgets from before (including any created by hand in the console), delete the extras:

```sh
aws budgets describe-budgets --account-id <acct> \
  --query 'Budgets[].[BudgetName,BudgetLimit.Amount,CostFilters]' --output table
aws budgets delete-budget --account-id <acct> --budget-name "<name>"
```
