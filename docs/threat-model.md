# Threat Model: What the Audit Chain Actually Proves

Most tools in this space say "tamper-proof" and stop there. That word is doing a lot of work it
cannot support, so this page states the boundary plainly: **what is detected, what is not, and
what would actually have to change for the "not" list to shrink.**

There is a test in this repository that asserts local verification *is* defeatable. It is not a
known bug we forgot to fix — it is the honest boundary, written as an executable assertion so it
cannot quietly stop being true.

## The short version

| | |
|---|---|
| **Tamper-evident** | ✅ yes — modification that does not go through Postledger is detectable |
| **Tamper-proof** | ❌ no — someone with write access to the file can rewrite history cleanly |
| **Proves *what* happened** | ✅ yes, to the extent the chain is anchored somewhere else |
| **Proves *who* did it** | ❌ no — over stdio there is no authenticated identity at all |

## What is detected

Each is covered by a test that goes red if the mechanism is removed.

**Content modification.** Every entry's hash covers its own fields *and all of its postings*.
Change an amount, a date, a description, an account — the hash no longer matches, and
`postledger verify` names the entry.

```bash
sqlite3 book.db "DROP TRIGGER entry_no_update"
sqlite3 book.db "UPDATE entries SET description='something else' WHERE seq=2"
postledger verify     # ok:false, problem at seq 2, exit code 5
```

**Deletion from the middle.** `chain_head` records every step ever taken. An entry removed from
the middle leaves a gap that no longer resolves.

**Truncation from the end.** The classic attack on a naive hash chain: delete the last N entries
and the remaining chain is still perfectly self-consistent. Postledger catches it because
`chain_head` is append-only and outlives the entries — if it reaches further than `entries` does,
the tail was cut.

**A swapped source document.** `verify` re-hashes every archived file on disk and compares it to
the fingerprint stored when it was archived. Storing a hash and never re-checking it — which is
common — means a replaced PDF is undetectable. Here it exits `5`.

**Derived data drift.** Balances are recomputed from postings and asserted against the cache; the
balance sheet asserts the accounting identity rather than assuming it. Because money is integer
minor units, a one-cent discrepancy is a real discrepancy, not a rounding artifact to wave away.

## What is not detected

### Someone with write access to the file

This is the big one and there is no way around it. With write access an attacker can:

```bash
sqlite3 book.db "DROP TRIGGER entry_no_delete; DROP TRIGGER posting_no_delete; ..."
# delete entries, delete the corresponding chain_head rows, recompute every
# hash from the new state
postledger verify     # ok: true
```

The repository's own test suite does exactly this and asserts that verification **passes**,
because a self-signed chain stored next to the data it signs cannot detect an attacker who
rewrites both. Any claim otherwise is cryptographic theatre.

The triggers are still worth having. They stop mistakes, migration scripts, well-meaning
contributors, and an agent with direct SQL access. They stop *slips*, not *intent*. That is a
real and useful category — most ledger corruption is a slip — but the two must not be conflated.

### Who did anything

The `actor` field is whatever the caller said it was. Over stdio there is no authentication of
any kind. The schema column is named `claimed_actor` precisely so that nobody reading the code
mistakes it for proof.

It is genuinely useful for accidents — which agent wrote these, which colleague posted to the
wrong book — and that is what `postledger revert-actor` is for. It is worthless against someone
who chooses to lie. If you need real identity, you need an authenticated transport in front of
the ledger, which is a different product.

### Consistent error

Cross-checks catch *inconsistency*: a hallucinated line rarely comes with a total that balances.
They do not catch an agent that reads a 400 invoice as 40 and consistently declares 40. Only a
balance assertion against external reality — or a human with the source document — catches that.

## What actually raises the bar

An attacker can rewrite what is on your disk. They cannot rewrite the copy that already left it.

```bash
postledger anchor --line >> anchors.log       # after each session
git -C anchors commit -am "anchor" && git push
postledger verify-anchors anchors.log         # check the book against those witnesses
```

Each line is `seq<TAB>hash<TAB>timestamp`. `verify-anchors` walks the log and checks that the book
still has that entry with that hash. If the tail was cut, the witness for `seq 3` has nothing to
match. If history was rewritten, the hashes disagree.

The same test that proves local verification is defeatable also proves this check catches it.

**Anchoring only works if the anchor leaves the machine.** A hash written to a file next to the
book proves nothing against whoever owns the book. Ordered by how much they cost an attacker:

1. **A remote git repo with protected branches** — cheap, and you probably already have one
2. **Another person** — email the line to your accountant after each close; now forgery needs their inbox too
3. **Object storage with a retention lock** — S3 Object Lock and equivalents cannot be deleted even by the account owner
4. **A timestamping authority** — OpenTimestamps (free, no account, anchors into Bitcoin, verifiable offline) or RFC 3161

There is also one that costs nothing and is specific to this tool's setting: **every write returns
the current chain head**, so in an MCP session that value lands in the conversation transcript —
stored by Anthropic or OpenAI, not by you, and not editable by whoever owns your laptop. It is not
a formal timestamping service and should not be described as one, but as a practical witness it is
free and it is already happening.

## Why the constraints are in the database

Application-layer checks protect you from today's callers. A trigger protects you from every
future one — a migration script, a cron job, a helpful contributor, an agent that got handed the
file path. The rule outlives the code path that was supposed to enforce it.

This is why balance is a `RAISE(ABORT)` and not an `if`. The failure mode we are designing against
is not "the current code has a bug"; it is "in eighteen months something writes to this file and
nobody remembers the rule."

## What we would need to change to say more

Honest answers to the obvious follow-ups:

- **"Make it tamper-proof."** Not achievable for a local file. It requires the log to live
  somewhere the user cannot write — a server, i.e. custody of the data, i.e. every obligation that
  comes with holding other people's financial records. That is a different product with a
  different threat model, not a feature to add here.
- **"Prove who wrote each entry."** Requires signing keys and an authenticated transport. Possible
  in principle (sign each entry, put the public key in the anchor log), not implemented, and it
  would only move the question to "who controls the key."
- **"Detect the consistent-error case."** Requires comparing against something outside the ledger —
  a bank feed, a statement, a human. `expect_balance_after` is the hook for this today.

## Related

- [Idempotency](./idempotency.md) — why every write takes a caller-supplied key
- [Append-only accounting](./append-only.md) — why nothing is ever edited or deleted
- [Main README](../README.md)
