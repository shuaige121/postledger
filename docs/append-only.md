# Append-Only Accounting: No Edits, No Deletes

Postledger has no `UPDATE` and no `DELETE` on the books. Not "discouraged", not "logged" — the
statements are refused by the database. A mistake is corrected by posting a reversing entry, so
both the mistake and the correction stay visible forever.

This is how paper ledgers worked for five hundred years, and the reason is unchanged: **a record
you can quietly change is not evidence of anything.**

## What it looks like

```bash
sqlite3 book.db "UPDATE postings SET amount = 1"
# Error: postledger: postings are immutable

sqlite3 book.db "DELETE FROM entries"
# Error: postledger: entries are append-only; correct with a reversal

sqlite3 book.db "UPDATE entries SET hash = 'forged'"
# Error: postledger: entries are append-only
```

That is `sqlite3` talking directly to the file, with Postledger nowhere in the picture. The rule
lives in the schema, so it applies to every writer that will ever touch the file — including the
ones nobody has written yet.

## Correcting a mistake

```bash
postledger reverse e_8516bbfe0fc344e2a374 --key fix-1 --reason "wrong counterparty"
```

This posts a **new** entry with the opposite legs. The account balances return to where they were;
the history grows. Afterwards you can see: what was posted, by whom, when it was undone, and why.
An edit would have shown you only the final state, with no way to know it had ever been different.

An entry can only be reversed once — a second attempt is refused. If the reversal itself was wrong,
post a fresh correcting entry rather than trying to un-reverse.

## Undoing one actor entirely

Because every entry carries its author and nothing is ever deleted, an entire footprint can be
withdrawn:

```bash
postledger revert-actor agent:rogue --key cleanup-1 --reason "malfunction" --dry-run
# → matched: 3, and exactly what each balance would become

postledger revert-actor agent:rogue --key cleanup-1 --reason "malfunction"
# → 3 reversing entries posted; balances back to where they started
```

This is the practical payoff of append-only. An agent that went wrong for an afternoon, or a batch
posted to the wrong book, does not require restoring a backup and losing everything posted since.
It reverses **and it says so** — the books read as if that actor never wrote, while the record of
what happened stays intact.

The batch key makes it resumable: re-running skips what was already reversed, so an interrupted
cleanup continues rather than double-reversing.

An honest caveat: `actor` is self-declared. This is a tool for accidents, not adversaries — see
[threat model](./threat-model.md).

## How the database enforces it

SQLite has no deferred constraints, which is normally what makes "validate the whole transaction"
awkward: while you insert postings one at a time, the entry is *necessarily* unbalanced in between.

Postledger inverts the write order so the problem disappears:

```
1. INSERT all postings       — the entry is unsealed and invisible to every read path
2. INSERT the entry header   — a BEFORE INSERT trigger validates the whole entry, right here
```

At the instant of sealing, one trigger checks everything at once: at least two postings, debits
equal credits, the leg count matches what the caller declared, the total matches what the caller
declared, no closed accounts, the date is past the lock date, and the chain links to the previous
entry.

Two consequences fall out of this ordering, both of which matter:

- **Entries never need `UPDATE`.** Nothing about a sealed entry ever changes, so append-only can be
  unconditional rather than a conditional trigger with exceptions to reason about.
- **A partial write leaves nothing behind.** If sealing fails the whole transaction rolls back.
  Postings written but never sealed are invisible to every report, and a separate view surfaces
  them so a crashed write can be cleaned up. They are the only rows in the schema that may be
  deleted, precisely because they are not part of the record.

```sql
CREATE TRIGGER posting_no_delete
BEFORE DELETE ON postings
BEGIN
  SELECT RAISE(ABORT, 'postledger: postings of a sealed entry are immutable')
  WHERE EXISTS (SELECT 1 FROM entries WHERE id = OLD.entry_id);
END;
```

Appending a leg *after* sealing is refused too — otherwise "write two balanced legs, seal, then add
a third" would walk straight around the check.

## What append-only does not give you

It bounds who can change history **through the tool**, and that is all. Someone with write access
to the file can drop the triggers. The chain makes that detectable rather than preventable, and
only until they recompute it; anchoring the head somewhere else is what raises that cost. See
[threat model](./threat-model.md) for the full boundary.

It also does not make the books *correct*. An entry that is wrong and never noticed stays wrong
forever, now with a permanent record of being wrong. Append-only preserves history; it does not
audit it. That is what the [statistical indicators](../README.md#statistical-forensics) and a human
reading source documents are for.

## Related

- [Idempotency](./idempotency.md) — why every write takes a caller-supplied key
- [Threat model](./threat-model.md) — what the chain proves and what it does not
- [Main README](../README.md)
