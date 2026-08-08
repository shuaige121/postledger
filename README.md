# Postledger

**Double-entry bookkeeping that assumes the bookkeeper is not trustworthy.**

Postledger is an idempotent, append-only double-entry ledger with a Unix CLI and an MCP server over
one SQLite file. It exists because AI agents retry: when a tool call times out and the model posts the
same journal entry again, most ledgers cheerfully create a duplicate. Postledger cannot — every write
carries an idempotency key, and replaying that key returns the original entry and posts nothing.

Balance is enforced by SQLite triggers, not by application code. Entries and postings have no UPDATE
and no DELETE path at all; a mistake is corrected with a reversing entry. Money is `bigint` minor units,
so there is no float anywhere and no rounding tolerance to exploit. `postledger verify` walks the hash
chain, recomputes every balance from the journal, and re-hashes each archived source document.

Three surfaces over the same file: a **Unix CLI**, an **MCP server** (14 tools), and a **local read-only
web view** in your browser. 304 tests. Zero runtime dependencies. Runs on Node 22.13+, needs no server,
no daemon, and no account.

There is no hosted version and there will not be one. This project is *structurally incapable* of holding
your data — a book is a SQLite file on your disk — and therefore structurally incapable of leaking it,
selling it, or walking away with it. That is not a promise about our intentions; it is a property of
where the file lives.

```bash
npx postledger --help
```

---

## 60 seconds, no signup

```bash
postledger init books/demo.db --name "Demo Co" --currency SGD
export POSTLEDGER_BOOK=books/demo.db

postledger account open Assets:Bank:Checking --type asset
postledger account open Income:Sales  --type income

postledger post --key inv-001 --date 2026-08-08 --desc "Invoice 001" \
  --leg "Assets:Bank:Checking debit  5000.00" \
  --leg "Income:Sales  credit 5000.00" \
  --expect-total 5000.00
```

Now try to break it:

```bash
# Replay the same key — returns the original entry, posts nothing
postledger post --key inv-001 ...      # "replayed": true, still 1 entry

# Off by one cent — rejected, exit code 2
postledger post --key x --leg "Assets:Bank:Checking debit 100.00" \
                        --leg "Income:Sales credit 99.00" --expect-total 100.00

# Edit the books behind postledger's back — the database itself refuses
sqlite3 books/demo.db "UPDATE postings SET amount = 1"
# Error: postledger: postings are immutable

sqlite3 books/demo.db "DELETE FROM entries"
# Error: postledger: entries are append-only; correct with a reversal
```

---

## Where this sits

There are several local-first double-entry MCP servers now. They mostly compete on **how much your
agent can do** — budgets, reconciliation, VAT, securities, cash-flow forecasting. Postledger competes on
a different axis: **whether you can trust what the agent did.**

Feature comparison, from reading the source of each project on 2026-08-08. Facts only; every project
listed is doing something legitimate and several are more feature-rich than this one.

| | Postledger | A | B | C | D |
|---|---|---|---|---|---|
| Storage | SQLite | SQLite | SQLite | PostgreSQL | JSONL file |
| Money as integer minor units | ✅ | ✅ | ✅ | — | ✅ |
| **General idempotency key on writes** | ✅ | — | — | — | ✅ |
| **Immutability enforced by DB triggers** | ✅ all tables | partial | ✅ postings | — | — |
| **Hash chain over entries** | ✅ | — | — | — | — |
| **External anchoring** | ✅ | — | — | — | — |
| **Bulk revert by actor** | ✅ | — | — | — | — |
| **Statistical fraud indicators** | ✅ | — | — | — | — |
| **Bookkeeper's error diagnostics** | ✅ | — | — | — | — |
| Document archive + fingerprint check | ✅ | ✅ | ✅ | ✅ | — |
| Breadth of features | moderate | **very high** | high | moderate | minimal |

*A = cloviscomputing/clovis · B = erikvankempen/bukio-cli · C = yuens1002/bookie · D = themusashimaru/ledgerkit-mcp*

Worth knowing: "idempotent" means different things across these projects. In several it refers to
**import deduplication** (re-importing a bank file doesn't duplicate rows, keyed on a natural key) or to
MCP's `idempotentHint` protocol metadata. Postledger uses it in the strict sense: a caller-supplied key
on every write, claimed atomically before any work happens, where replay returns the original result.

---

## The seven guarantees

| Guarantee | Enforced by | Where |
|---|---|---|
| Debits equal credits | `RAISE(ABORT)` in a trigger, at seal time | `schema.sql` |
| Retries never double-post | Key claimed **before** the work — no check-then-act window | `ledger.ts` |
| Nothing is edited or deleted | `BEFORE UPDATE/DELETE` triggers on every table | `schema.sql` |
| No floating point, ever | `bigint` minor units; there is deliberately no `fromNumber()` | `money.ts` |
| The caller's own total must match | `expected_total` is cross-checked against the legs | `ledger.ts` |
| Source documents stay verifiable | Content-addressed; `verify` re-hashes the file on disk | `ledger.ts` |
| Tampering is detectable | Hash chain over entries **and** their postings | `ledger.ts` |

Each row has a test that goes red if you remove the mechanism. `npm test` runs 304 of them across six
suites, including one that drives the real CLI and speaks real MCP over stdio.

### Why the database and not the application layer

`debits == credits` in application code protects you from today's callers. In a trigger it protects you
from every future one — a migration script, a cron job, a helpful contributor, an agent with direct SQL
access. The rule outlives the code path that was meant to enforce it.

SQLite has no deferred constraints, so the write protocol is inverted to make that stop mattering:

```
1. INSERT all postings      — the entry is unsealed, invisible to every read path
2. INSERT the entry header  — a BEFORE INSERT trigger validates the whole entry at this instant
```

There is no window in which an unbalanced entry is visible, and appending a leg after sealing is
rejected.

---

## Use it from Claude, ChatGPT, or any MCP client

```json
{
  "mcpServers": {
    "postledger": {
      "command": "npx",
      "args": ["-y", "postledger", "mcp", "--book", "/absolute/path/to/books/demo.db"]
    }
  }
}
```

The tool surface is shaped so the model has little room to get it wrong:

- `postledger_post_entry` requires an `idempotency_key` **and** an `expected_total` the caller computed
  itself. A hallucinated line item rarely arrives with a total that happens to balance.
- Amounts are strings, never JSON numbers. `JSON.parse` turns `125.50` into an imprecise double before
  any validator could see it, so it is refused at the boundary with an explanation.
- Unknown account? The error carries `did_you_mean` candidates rather than leaving the model guessing.
- Unbalanced? The error runs the classic bookkeeper's checks and names the likely mistake:

  > `debits 54.00 != credits 45.00 (off by 9.00)` —
  > *the difference is divisible by 9, the classic signature of a transposition error — two digits
  > swapped somewhere (e.g. 54 typed as 45). Re-read each amount against the source document.*

  It also catches the two other classics: a difference that is exactly twice one leg (that leg is on the
  wrong side) and a difference that equals one leg exactly (its counterpart is missing).

Every write returns the current chain head. In an MCP session that value lands in the conversation
transcript — a copy of your ledger's fingerprint that lives outside the machine holding the ledger.

---

## Look at the books in a browser

```bash
postledger serve                    # http://127.0.0.1:7777
```

A single self-contained page: overview, chart of accounts, balance sheet, income statement, journal, and
the forensics panel. No build step, no framework, no CDN — the HTML you can read is the HTML that runs,
and a CSP of `default-src 'none'` means the page cannot reach the network even if something got into it.

Two deliberate limits: it is **read-only** (writing stays with the CLI and MCP, so there is no form to
CSRF and no session to steal), and it **binds `127.0.0.1`** unless you explicitly pass `--host`. Your
books should not become reachable because you left a tab open.

---

## When an agent goes wrong

Every entry is signed with its author and nothing is ever deleted, so one actor's entire footprint can be
undone:

```bash
postledger revert-actor agent:rogue --key cleanup-1 --reason "malfunction" --dry-run
# → matched: 3, and exactly what each balance would become

postledger revert-actor agent:rogue --key cleanup-1 --reason "malfunction"
# → 3 reversing entries posted; balances back to where they were
```

It **reverses**, it does not delete. The books end up as if that actor never wrote, while the record of
what happened — what was posted, by whom, when it was undone and why — stays intact. Deleting would
defeat the point of keeping an audit trail.

Re-running with the same batch key is safe: already-reversed entries are recognised and skipped, so an
interrupted cleanup resumes rather than double-reverting.

---

## Statements

```bash
postledger balance-sheet --table
postledger income-statement --from 2026-01-01 --to 2026-03-31
```

The balance sheet **asserts** the accounting identity rather than assuming it:

```
assets = liabilities + equity + (income − expenses)
```

If that does not hold exactly it returns `ok: false`, prints the exact gap, and exits `5`. There is no
rounding tolerance to hide behind — money is integer minor units, so a difference of one cent is a real
difference and means something is wrong. Profit for the period is shown as its own line inside equity
rather than folded in silently, so retained earnings and this period's result stay distinguishable.

## A report you can send to your accountant

```bash
postledger export --format html > audit-report.html
```

One self-contained file. It opens from `file://`, makes **no network request at all** (verified in CI by
intercepting every request), and carries the chain head plus the integrity result in a banner at the top
— so whoever receives it can run `postledger verify` against the original book and compare hashes.

It reuses the exact page `postledger serve` renders, so there is no second reporting engine to drift out
of sync with the first. A report nobody can check is decoration; this one states what it is (a
point-in-time snapshot, not a live view) and how to check it.

## Your data is not held hostage

```bash
postledger export --format journal > books.journal   # hledger/ledger format
hledger -f books.journal balancesheet                # someone else's tool, your data

postledger import books.journal --dry-run            # see what would happen
postledger import books.journal
```

Round-trip is lossless. Postledger's own facts (entry id, idempotency key, actor) ride along in tag
comments, which ledger-likes preserve and ignore — so an export re-imports without inventing a dialect.

Direction is the one real difference between the formats and it is handled explicitly: Postledger uses an
explicit `side` with a strictly positive amount; ledger-likes use a sign. Positive is debit, negative is
credit, and the export writes that convention into the file header.

Import goes through the same `post()` path as everything else — an import is not a back door, and the
same invariants apply. Idempotency keys are derived from the file and position, so re-running an import
is a no-op rather than a duplicate. Anything Postledger does not model (virtual postings, multi-commodity
legs, automated transaction rules) is **rejected with the line number**, never silently dropped: a tool
that quietly discards part of your file is worse than one that refuses it.

---

## Statistical forensics

```bash
postledger audit
```

Benford first-digit distribution, round-number density, duplicate amounts, clustering just below approval
thresholds, and outliers by modified Z-score. Fabricated numbers have a fingerprint — people and language
models both favour uniform leading digits, round figures, and amounts sitting just under a limit. Real
ledgers do not.

**These are indicators, not evidence.** Deviation is not fraud and conformity is not innocence: a careful
fabricator can match Benford on purpose, and plenty of honest ledgers fail it (fixed contract prices, a
natural floor or cap, or simply too few entries). Below 100 samples the tool refuses to draw a conclusion
at all. The output repeats this caveat every time. It tells you which entries to pull the source document
for. Nothing more.

---

## Threat model, honestly

**What the audit chain detects**

- Accidental corruption
- Any modification that did not go through Postledger
- Entries deleted from the middle or the end of the chain
- An archived source document swapped for a different file

**What it cannot do**

- **Stop someone who owns the machine.** With write access to the file, an attacker can drop the
  triggers, rewrite history, and recompute the chain so it verifies clean. There is a test in this
  repository that does exactly that and *asserts local verification passes* — because claiming otherwise
  would be the dishonest choice.
- **Prove who did anything.** Over stdio there is no authenticated identity. The `actor` field is
  self-declared, and the schema column is called `claimed_actor` so nobody mistakes it for proof. Good
  for tracing accidents, useless against an adversary.

**What actually raises the bar**

```bash
postledger anchor --line >> anchors.log     # after each session
git -C anchors commit -am "anchor" && git push
postledger verify-anchors anchors.log       # check the book against those witnesses
```

An attacker can rewrite what is on your disk. They cannot rewrite the copy that already left it. The same
test that proves local verification is defeatable also proves the anchor check catches it. Anchor
somewhere you do not control — a remote repo, a colleague, another host — and the more places, the higher
the cost of forgery.

---

## Design decisions

**One book per file.** A book is a file you can `cp`, `tar`, `rsync`, `chmod`, and `sha256sum`. Backup is
copy. Isolation is file permissions — which matters, because with no trustworthy identity in the
application layer, the filesystem is the only real access control there is. Reporting across books is a
separate read-only command, not a reason to put five companies in one file.

**No account tree table.** Hierarchy lives in the name (`Expenses:Meals:Team`) and reports aggregate by
prefix. That removes parent ids, closure tables, and subtree moves in one stroke.

**One currency per book.** Multi-currency drags in rates, translation, and revaluation — half a project.
Need another currency? Open another book.

**Zero runtime dependencies.** The only thing the published package imports is `node:` builtins —
`node:sqlite` for storage, `node:http` for the web view, `node:crypto` for the chain. TypeScript is a
build-time dependency and nothing else. The MCP server is ~350 lines of newline-delimited JSON-RPC rather
than an SDK, because a financial tool people are asked to audit should be readable end to end.

(During development Node runs the `.ts` sources directly, so there is no build step in the loop. The
package is compiled for publication because Node deliberately refuses to strip types from anything under
`node_modules` — shipping `.ts` files would install cleanly and then crash on first run. CI installs the
real tarball into a clean directory and drives the binary, so that failure mode cannot come back.)

**Deliberately not in v1:** multi-currency, invoice/AR/AP state machines, period-close automation, a web
UI, bank imports. None of them change whether an AI can keep books safely, which is the only thing this
is trying to be good at.

---

## Install

Requires **Node 22.13+** — that is where `node:sqlite` became available without a flag (measured, not guessed). Contributors running the TypeScript sources directly need 22.18+, where type stripping is on by default.

```bash
npx postledger --help          # no install
npm install -g postledger      # or install it
```

Or Docker — the image runs the full test suite at build time, so an image that exists is an image whose
invariants held:

```bash
docker run -v "$PWD/books:/books" ghcr.io/shuaige121/postledger \
  init /books/demo.db --name "Acme Co" --currency USD
```

A book is one SQLite file, so the entire deployment story is that one `-v`. No database service, no
migrations to run, nothing to back up except a directory.

As a library:

```ts
import { Ledger } from 'postledger';

const book = Ledger.open('books/demo.db');
book.post({
  idempotencyKey: 'stripe_evt_1P9x…',      // the real-world event id
  date: '2026-08-08',
  description: 'Stripe payout',
  legs: [
    { account: 'Assets:Bank:Checking', side: 'debit',  amount: '4820.15' },
    { account: 'Expenses:Fees',   side: 'debit',  amount: '179.85'  },
    { account: 'Income:Sales',    side: 'credit', amount: '5000.00' },
  ],
  expectedTotal: '5000.00',
  actor: 'agent:stripe-sync',
});
```

## Exit codes

`0` ok · `1` error · `2` validation failed · `3` idempotency conflict · `4` book problem ·
`5` integrity check failed

```bash
postledger verify || echo "the books need attention"
```

## Tests

```bash
npm test
```

304 assertions across six suites: schema invariants, money arithmetic, the engine, forensics, reports
and journal interop, and an end-to-end pass that drives the real CLI and speaks real MCP over stdio.

## License

MIT
