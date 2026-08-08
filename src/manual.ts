/**
 * The operating manual, as data.
 *
 * Mounted in three places so a model finds it however it looks: as the MCP
 * `instructions` handed over at initialize, as readable resources, and as a
 * plain read-only tool. One source, three doors.
 *
 * Written for a caller that will act on it, so it says what to do and what not
 * to, not what the system is. Every "do not" here corresponds to something the
 * database will actually refuse — the manual explains the rules rather than
 * being the rules, because a rule that lives only in prose is not a rule.
 */

export interface ManualTopic {
  topic: string;
  summary: string;
  guidance: string[];
  recommended_tools: string[];
  warnings: string[];
}

export const MANUAL: ManualTopic[] = [
  {
    topic: 'getting-oriented',
    summary:
      'One book is one SQLite file. Accounts are colon paths (Assets:Bank:Checking) and hierarchy lives ' +
      'in the name, not in a table. Every figure is exact: money is integer minor units, never a float.',
    guidance: [
      'Read the chart of accounts before your first posting. You may only post to accounts that already exist.',
      'Amounts are always strings in JSON ("1200.00"). A JSON number is a float and is refused at the boundary.',
      'One book holds exactly one currency. Another currency means another book.',
      'Check postledger_info if you want to know how far the books are closed and where the chain head is.',
    ],
    recommended_tools: ['postledger_chart', 'postledger_info', 'postledger_trial_balance'],
    warnings: [
      'Never invent an account to make a posting go through. If one is missing, say so and ask.',
      'Do not reason about balances from entries you listed — ask for the balance. The database computes it.',
    ],
  },
  {
    topic: 'posting-safely',
    summary:
      'Every write takes an idempotency key derived from the real-world event, plus a total you computed ' +
      'yourself. Both exist because retries and dropped lines are normal, not exceptional.',
    guidance: [
      'Derive idempotency_key from the event: an invoice number, a bank reference, a webhook id. Never from a timestamp or a random value.',
      'If a call may already have gone through, retry with the SAME key. That is what makes it safe.',
      'If you changed anything — an amount, a date, an account — use a NEW key. The same key with different contents is refused.',
      'expected_total is the debit-side total. Compute it independently, then let the server disagree with you.',
      'Use dry_run first for anything you are unsure about: every check runs, nothing is stored, and the key is not consumed.',
      'Use postledger_allocate to split an amount. Do not divide by hand — three "thirds" of 100 that sum to 99.99 will be rejected.',
    ],
    recommended_tools: ['postledger_post_entry', 'postledger_allocate', 'postledger_balance'],
    warnings: [
      'A validation failure is not a reason to try a different shape of the same entry. Read the hint; it names the likely mistake.',
      'Never post figures you inferred. Post what the source document says, and ask when a field is unknown.',
    ],
  },
  {
    topic: 'correcting-mistakes',
    summary:
      'Nothing is ever edited or deleted. A mistake is corrected by a reversing entry, so both the error ' +
      'and its correction stay visible.',
    guidance: [
      'To correct one entry, reverse it and post the right one.',
      'To undo everything one author wrote — an agent that went wrong, a batch in the wrong book — use revert_actor.',
      'Always run revert_actor with dry_run first and show the user what would change before applying it.',
      'An entry can only be reversed once. If the reversal itself was wrong, post a fresh correcting entry.',
    ],
    recommended_tools: ['postledger_reverse_entry', 'postledger_revert_actor', 'postledger_list_entries'],
    warnings: [
      'Do not describe a reversal as a deletion when reporting to the user. The original is still there, and that is the point.',
      'revert_actor is destructive in effect even though it only adds entries. Confirm before applying.',
    ],
  },
  {
    topic: 'checking-against-reality',
    summary:
      'The hash chain proves nobody altered what is written down. It cannot tell you something was never ' +
      'written down at all. Assertions are the only check that catches that.',
    guidance: [
      'After comparing against a statement, record it: assert_balance with a note saying what you checked against.',
      'A figure that disagrees is refused, and the response states the gap. That gap is the finding — investigate it, do not work around it.',
      'Use stale_assertions to decide what to reconcile next.',
      'Run verify after any bulk operation. Its exit is meaningful: problems are listed with the specific check that failed.',
    ],
    recommended_tools: ['postledger_assert_balance', 'postledger_stale_assertions', 'postledger_verify'],
    warnings: [
      'Never record an assertion you know to be false in order to "make it pass". That converts a caught error into a hidden one.',
      'A passing chain check is not evidence the books are complete. Say so when you report it.',
    ],
  },
  {
    topic: 'importing-statements',
    summary:
      'read_statement parses a bank CSV into candidates and posts nothing. Deciding which account faces ' +
      'each line is your judgement, which is exactly why it is not automated.',
    guidance: [
      'Map the reference column if the bank provides one. A bank reference identifies a row far better than a hash of its contents.',
      'Use each candidate suggested_key as the idempotency_key when posting, so re-importing the same file is a no-op.',
      'already_posted tells you which candidates are new. Work through the new ones.',
      'Pass date_format when the parser asks: it only asks when the date is genuinely ambiguous.',
      'For a card statement, check whether a purchase is printed positive. If so, pass invert_sign.',
    ],
    recommended_tools: ['postledger_read_statement', 'postledger_post_entry', 'postledger_chart'],
    warnings: [
      'Do not guess the account for an unclear line. Group the unclear ones and ask.',
      'Do not silently drop rows you could not classify. Report the count.',
    ],
  },
  {
    topic: 'closing-a-period',
    summary:
      'A close is a named event covering everything up to a date. Reopening is possible and is recorded ' +
      'with a reason.',
    guidance: [
      'Before closing: verify passes, the trial balance balances, and the accounts you care about have current assertions.',
      'Name a close the way you would say it out loud: "FY2026 Q1", "March 2026".',
      'A rejected posting with PERIOD_LOCKED means the date falls in a closed period. Report that to the user rather than moving the date.',
    ],
    recommended_tools: ['postledger_close_period', 'postledger_periods', 'postledger_verify'],
    warnings: [
      'Never reopen a period without asking. Somebody closed it deliberately, and the reopening becomes permanent record.',
      'Never move an entry date to sidestep a closed period. That is falsifying when something happened.',
    ],
  },
  {
    topic: 'reading-forensics',
    summary:
      'The audit tool reports statistical indicators. Every one of them is a reason to look, never a ' +
      'finding on its own.',
    guidance: [
      'Report indicators as indicators. Deviation is not fraud, and conformity is not innocence.',
      'Below about 100 entries Benford says nothing at all; the tool refuses to draw a conclusion and so should you.',
      'Follow a signal by pulling the actual entries with list_entries filters, then look at the source documents.',
    ],
    recommended_tools: ['postledger_audit', 'postledger_list_entries', 'postledger_ageing'],
    warnings: [
      'Never tell a user their books are fraudulent because of a statistical signal. Say which entries are worth opening.',
      'Legitimate causes are common: fixed contract prices, a natural floor or cap, a small sample.',
    ],
  },
  {
    topic: 'what-this-cannot-do',
    summary:
      'Stated plainly so you do not overclaim on its behalf: tamper-evident, not tamper-proof; identity ' +
      'is claimed, not verified.',
    guidance: [
      'The chain detects modification that did not go through postledger. Someone with write access to the file can rewrite history and recompute it cleanly.',
      'The actor field is whatever the caller said. It traces accidents; it proves nothing about an adversary.',
      'What raises the bar is anchoring the chain head somewhere outside the machine — a remote repo, another person, object storage with a retention lock.',
      'Cross-checks catch inconsistency, not consistent error. An invoice read as 40 instead of 400, declared as 40, passes everything.',
    ],
    recommended_tools: ['postledger_verify', 'postledger_actors'],
    warnings: [
      'Never describe this ledger as tamper-proof, immutable-by-cryptography, or blockchain-backed. It is none of those.',
      'Never present the actor field as proof of who did something.',
    ],
  },
];

/** The condensed form handed over at initialize, where budget is tight. */
export const INSTRUCTIONS = `Double-entry bookkeeping with invariants enforced by the database.

Before your first posting, call postledger_chart — you may only post to accounts that already exist,
and inventing one is refused.

Every write needs an idempotency_key derived from the real-world event (invoice number, bank reference,
webhook id), so a retry is safe. Retrying? Reuse the SAME key. Changed an argument? Use a NEW one.

Amounts are strings, never JSON numbers. Post what the source document says; ask when a field is
unknown rather than filling it in. Corrections are reversals, never edits.

The chain proves nothing was altered. It cannot tell you something was never recorded — use
postledger_assert_balance after checking against a statement; that is the only check that catches a
missing entry.

Use dry_run when unsure: every check runs, nothing is stored, and the key is not consumed.

Full guidance: postledger_manual, or the postledger://manual/* resources.`;

export function manual(topic?: string) {
  if (!topic) {
    return {
      ok: true as const,
      topics: MANUAL.map((m) => ({ topic: m.topic, summary: m.summary })),
      note: 'Call again with a topic for its guidance, recommended tools and warnings.',
    };
  }
  const found = MANUAL.find((m) => m.topic === topic);
  if (!found) {
    return {
      ok: false as const,
      error: `no topic named ${JSON.stringify(topic)}`,
      available: MANUAL.map((m) => m.topic),
    };
  }
  return { ok: true as const, ...found };
}
