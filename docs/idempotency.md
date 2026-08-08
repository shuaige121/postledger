# Idempotent Ledger: Safe Retries for AI Agents

Your agent will post the same journal entry twice. Not because it is badly written — because
that is what happens when a tool call times out, a session resumes, or a context gets compacted
and replayed. The network drops the *response*, not the *write*. From the agent's side those two
are indistinguishable.

Most ledgers will cheerfully accept the second copy. Your books now say you were paid twice.

This page describes how Postledger makes that impossible, and — more usefully — the specific ways
"we support idempotency" turns out to mean nothing.

## The failure, precisely

```
agent                                    ledger
  |                                        |
  |--- post entry, 5000.00 ------------->  |
  |                                        |  written ✓
  |         <---- response ----X           |  (lost)
  |                                        |
  |  30s timeout. Retry.                   |
  |--- post entry, 5000.00 ------------->  |
  |                                        |  written AGAIN ✗
```

Nothing here is a bug in the agent. Retrying a request whose response never arrived is the
*correct* behaviour for an unreliable channel. The ledger is what has to be built for it.

Note the sinister property: the books still balance. Debits still equal credits. A trial balance
looks perfect. Every automated check passes, and the only thing wrong is that the number is twice
what it should be — which nobody notices until a reconciliation months later.

## The fix: a key supplied by the caller

Every write takes an `idempotency_key` derived from the **real-world event**, not from the
attempt:

```bash
postledger post --key inv-2026-001 --date 2026-08-08 --desc "Invoice 001" \
  --leg "Assets:Bank:Checking debit  5000.00" \
  --leg "Income:Sales         credit 5000.00" \
  --expect-total 5000.00
```

Replay it and you get the original entry back, with `"replayed": true`, and the book still holds
exactly one entry. Not an error — the *same answer*. That distinction matters: an agent that
receives an error will try to fix something, and there is nothing to fix.

The key must come from the event: an invoice number, a bank reference, a webhook event id, a POS
transaction number. A key derived from the attempt (a UUID generated at call time, a timestamp)
is worse than no key at all, because it looks like protection and provides none — the retry
generates a fresh one and posts a duplicate.

## Where implementations go wrong

### 1. Check-then-act

The obvious implementation has a hole:

```
SELECT ... WHERE key = ?     -- not found
                                    ← a concurrent request slips in here
INSERT ...                   -- both succeed, or one crashes with a raw DB error
```

Postledger claims the key *before* doing any work, in the same transaction. The claim **is** the
atomic operation, so there is no window between checking and acting:

```
BEGIN IMMEDIATE
  INSERT INTO idempotency (key, request_hash, status) VALUES (?, ?, 'in_progress')
     ├─ success   → this attempt owns the key; do the work
     └─ conflict  → read the existing row and answer from it
  <do the work>
  UPDATE idempotency SET status = 'completed', response = ?
COMMIT
```

The conflict branch answers by cases, and each case matters:

| existing row | answer |
|---|---|
| same `request_hash`, completed | the original result, `replayed: true` |
| same `request_hash`, in progress | a clean "this is already running" — not a crash |
| **different `request_hash`** | **loud conflict** — same key, different content |
| stale `in_progress` (> 5 min) | reclaimed; a crashed attempt does not wedge the key forever |

### 2. Silence on conflict

A key must be bound to one exact request. If a caller reuses a key with different arguments, that
is a bug in the caller and it must be **loud**. Silently returning the old result would hide a
mistake — the agent believes it posted 6000 and the book says 5000, with no error anywhere.

### 3. Burning the key on a validation failure

This one is subtle and we shipped it wrong first.

The natural implementation claims the key, validates, and marks the key `failed` if validation
fails. Now the model — which used `inv-2026-001` because that is genuinely the event it is
recording — fixes the amount and retries with the same key, and gets `IDEMPOTENCY_CONFLICT`.
It did the right thing and got punished.

Validation is pure and read-only. A rejected request was never *accepted*, so it must not consume
the key. Postledger validates **before** claiming. Keys are for operations that started producing
side effects, not for typos.

### 4. "Idempotent" meaning something else entirely

Read the source before believing the word. Across comparable projects it currently means, variously:

- **import deduplication** — re-importing a bank statement does not duplicate rows, keyed on a
  natural key in the file. Useful, and unrelated to retry safety.
- **reconciliation deduplication** — already-cleared postings are not re-cleared.
- **MCP's `idempotentHint`** — a protocol metadata field describing a tool to the client. It is a
  *label*, not a mechanism; nothing enforces it.

None of these stop the double-post above. Ask instead: *is there a caller-supplied key on the
write path, and what happens if I send the same key twice with different amounts?*

## Beyond the key: catching the errors a key cannot

Idempotency stops the *same* entry from landing twice. It does nothing about a *wrong* entry
landing once. Postledger asks the caller to declare, independently, what it believes it is doing:

- `expected_total` — the debit-side total, computed by the caller. Disagree with the legs and the
  entry is rejected.
- `declared_legs` — how many postings there should be. Catches a dropped or duplicated line even
  when the amounts happen to balance.
- `expect_balance_after` (optional) — what one account should total afterwards. Catches posting to
  the wrong account, or the right account on the wrong side.

The principle: **a hallucinated line item rarely arrives with a total that happens to balance.**
Model errors are usually *internally inconsistent*, so requiring two independently derived
statements of the same fact catches them cheaply.

The limit is worth stating: this catches inconsistency, not consistent error. An agent that reads
a 400 invoice as 40 and declares a total of 40 passes every check here. For that you need the
balance assertion above, or a human looking at the source document.

## Verifying the claim yourself

```bash
postledger init /tmp/demo.db --name Demo --currency USD
export POSTLEDGER_BOOK=/tmp/demo.db
postledger account open Assets:Bank:Checking --type asset
postledger account open Income:Sales --type income

POST=(post --key evt_1 --date 2026-08-08 --desc "Payment"
      --leg "Assets:Bank:Checking debit 100.00"
      --leg "Income:Sales credit 100.00" --expect-total 100.00)

postledger "${POST[@]}"        # "replayed": false
postledger "${POST[@]}"        # "replayed": true
postledger info | grep entries # 1

# same key, different amount → loud conflict, exit code 3
postledger post --key evt_1 --date 2026-08-08 --desc "Payment" \
  --leg "Assets:Bank:Checking debit 999.00" \
  --leg "Income:Sales credit 999.00" --expect-total 999.00
echo $?
```

## Related

- [Append-only accounting](./append-only.md) — why nothing is ever edited or deleted
- [Threat model](./threat-model.md) — what the audit chain does and does not prove
- [Main README](../README.md)
