/**
 * MCP server — stdio transport, zero dependencies.
 *
 * MCP's stdio transport is just newline-delimited JSON-RPC 2.0, and the core
 * surface is only three methods: initialize / tools/list / tools/call.
 * Pulling in an SDK for that little would cost the whole project its
 * "zero dependencies" property — not a good trade for a financial tool
 * that's meant to be audited by other people.
 *
 * Design principle for the tool surface: **make the model unable to get it
 * wrong, rather than catching it after it does**.
 *   - Every write requires idempotency_key (retries are the normal case,
 *     not the exception)
 *   - post requires expected_total (a self-reported figure for cross-checking,
 *     which catches a missing line or a bad sum)
 *   - Amounts are always strings (a JSON number is a float — it's already
 *     imprecise before validation ever sees it)
 *   - A misspelled account returns candidates instead of leaving the model
 *     to keep guessing
 *   - Every error carries a hint, and the hint is **the next action to take**
 *   - Every write echoes back the chain head, which lands in the conversation
 *     transcript — a witness that even root on this machine can't edit
 */

import { Ledger, PostledgerError } from './ledger.ts';
import { MANUAL, INSTRUCTIONS, manual } from './manual.ts';
import { VERSION } from './version.ts';
import { createInterface } from 'node:readline';

const AMOUNT_DESC =
  'Decimal string, e.g. "1200.00". MUST be a string, never a JSON number — ' +
  'JSON numbers are floats and lose precision before the server ever sees them.';

const IDEM_DESC =
  'Required. Derive it from the real-world event you are recording (invoice number, bank reference, ' +
  'webhook id) so the same event always produces the same key. Replaying a key returns the original ' +
  'result instead of posting twice. If you CHANGE any argument, use a NEW key.';

const TOOLS = [
  // ---- read ----------------------------------------------------------------
  {
    name: 'postledger_manual',
    description:
      'How to use this ledger well: posting safely, correcting mistakes, checking against reality, ' +
      'importing statements, closing periods, reading the forensic signals, and — stated plainly — ' +
      'what this system cannot do. Call with no topic for the list. ' +
      'Worth reading before a task you have not done here before.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Omit to list the available topics' } },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_chart',
    description:
      'List the chart of accounts with current balances. CALL THIS FIRST before posting anything — ' +
      'you may only post to accounts that already exist, and inventing an account name will be rejected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'postledger_balance',
    description: 'Balance of one account, or of a subtree by prefix (e.g. "Expenses" covers all expense accounts).',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Exact account, e.g. "Assets:Bank:Checking"' },
        prefix: { type: 'string', description: 'Subtree prefix instead, e.g. "Expenses"' },
        as_of: { type: 'string', description: 'YYYY-MM-DD — the balance at the END of that date. Omit for now.' },
        subtree: { type: 'boolean', description: 'Include sub-accounts beneath this one' },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_trial_balance',
    description: 'Trial balance: every account plus total debits and credits. If these differ, the books are broken.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'postledger_balance_sheet',
    description:
      'Balance sheet: assets, liabilities, equity, and profit not yet closed into equity. ' +
      'The accounting identity (assets = liabilities + equity + profit) is checked, not assumed — ' +
      'if it fails the response says ok:false and reports the exact gap, which means the books are ' +
      'damaged and you should report that rather than the numbers.',
    inputSchema: {
      type: 'object',
      properties: { as_of: { type: 'string', description: 'YYYY-MM-DD; omit for right now' } },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_income_statement',
    description:
      'Income statement (profit and loss) for a period. Omit both dates for since-inception. ' +
      'Income and expense balances are cumulative, so a bounded period is computed as the ' +
      'difference between two snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_list_entries',
    description:
      'Journal entries, newest first, with filters. This is how you pull up the specific entries ' +
      'something else pointed at — an audit signal, an ageing bucket, a stale assertion.\n' +
      'Paging: the response carries next_before_seq; pass it back as before_seq for the next page. ' +
      'Null means you reached the end, so the whole history can be walked without guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Exact account or a prefix — "Expenses" covers every expense account' },
        since: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        until: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        actor: { type: 'string', description: 'Only entries claiming this author' },
        describes: { type: 'string', description: 'Substring of the description' },
        tag: { type: 'string', description: 'Entries carrying this tag key' },
        tag_value: { type: 'string', description: 'Narrow the tag to this exact value' },
        tax_code: { type: 'string', description: 'Entries with a leg carrying this tax code' },
        min_amount: { type: 'string', description: 'Minimum entry total. ' + AMOUNT_DESC },
        max_amount: { type: 'string', description: 'Maximum entry total. ' + AMOUNT_DESC },
        before_seq: { type: 'integer', description: 'Paging cursor from a previous response' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_verify',
    description:
      'Integrity check: hash chain continuity, derived balances recomputed from the journal, and the ' +
      'on-disk fingerprint of every archived document. Returns ok:false with the specific problem if anything fails.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'postledger_audit',
    description:
      'Statistical forensics: Benford first-digit distribution, round-number density, duplicate amounts, ' +
      'clustering just below approval thresholds, outliers. ' +
      'IMPORTANT: every result is an INDICATOR, not evidence. Deviation is not fraud and conformity is not ' +
      'innocence. Use it to decide which entries deserve a look at the source document — never to conclude that ' +
      'books are fraudulent. Say so when you report the results.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: 'Restrict to entries touching this account' } },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_ageing',
    description:
      'How old is the money in one account, bucketed (current, 1-30, 31-60, 61-90, 90+). ' +
      'Reversed entries are excluded — a reversed receivable is cancelled, not overdue. ' +
      'Use for receivables and payables ageing.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        as_of: { type: 'string', description: 'YYYY-MM-DD; omit for today' },
      },
      required: ['account'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_convert',
    description:
      'Convert a foreign amount at a stated rate, exactly. Use this instead of multiplying yourself — ' +
      'the rate is handled as a fraction rather than a float, so the result cannot be a cent off, and a ' +
      'cent off is an entry the ledger will refuse.\n\n' +
      'Then post the CONVERTED figure as the leg amount and pass fx_currency / fx_amount so the original ' +
      'survives on the leg. That is what multi-currency means for a book kept in one currency.\n\n' +
      'This does not handle exchange gain or loss (a receivable settling at a different rate) or ' +
      'period-end revaluation. Those are about rate movement, not conversion — post them as ordinary ' +
      'entries against an FX gain/loss account.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'The foreign amount. ' + AMOUNT_DESC },
        from: { type: 'string', description: 'Its currency, e.g. "EUR"' },
        rate: { type: 'string', description: 'Units of the book currency per unit of `from`, e.g. "1.0811". A decimal string.' },
        to: { type: 'string', description: 'Target currency; defaults to the book currency' },
      },
      required: ['amount', 'from', 'rate'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_allocate',
    description:
      'Split an amount by integer ratios so the parts sum EXACTLY to the original — no cent lost, ' +
      'no cent invented (largest-remainder method). Use this instead of doing the division yourself: ' +
      'three "thirds" of 100.00 computed by hand come to 99.99 or 100.01, and the ledger will reject ' +
      'the resulting entry. A participant with ratio 0 receives exactly 0.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: AMOUNT_DESC },
        ratios: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1,
                  description: 'Non-negative integers, e.g. [1,1,1] for an even three-way split' },
      },
      required: ['amount', 'ratios'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_assert_balance',
    description:
      'Confirm that an account holds exactly this much RIGHT NOW, and record that confirmation ' +
      'permanently.\n\n' +
      'This is the only check in the system that looks outward. The hash chain proves nobody altered ' +
      'what is written down; it cannot tell you something was never written down at all. An entry that ' +
      'was simply missed leaves books that are internally flawless and wrong — chain intact, trial ' +
      'balance level, accounting identity satisfied.\n\n' +
      'Use it after comparing against something real: a bank statement, a card statement, a counted ' +
      'cash drawer. If the figure disagrees with the books the call is REJECTED and reports the ' +
      'difference — that is the point. Do not go looking for a way to record it anyway; find what is ' +
      'missing and post it.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        amount: { type: 'string', description: 'The real balance you are confirming. ' + AMOUNT_DESC },
        subtree: { type: 'boolean', default: false,
          description: 'True if the figure covers this account and everything beneath it ' +
                       '("Assets" covering "Assets:Bank:Checking").' },
        note: { type: 'string', description: 'What it was checked against, e.g. "July bank statement"' },
        actor: { type: 'string' },
      },
      required: ['account', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'postledger_list_assertions',
    description: 'Every balance ever confirmed, newest first. Shows what was checked, when, and against what.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_stale_assertions',
    description:
      'Accounts that were confirmed once and have moved a lot since. An account that looks tended but ' +
      'is not is more dangerous than one nobody ever claimed to watch. Use it to decide what to reconcile next.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, default: 30 } },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_close_period',
    description:
      'Close a period: nothing dated on or before this can be posted afterwards. ' +
      'Give it a name you would use out loud ("FY2026 Q1"). Reopening later is possible and is ' +
      'permanently recorded with a reason — closing the books is not the one operation that leaves no trace.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, as_of: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        note: { type: 'string' }, actor: { type: 'string' },
      },
      required: ['name', 'as_of'], additionalProperties: false,
    },
  },
  {
    name: 'postledger_reopen_period',
    description:
      'Reopen a closed period. Requires a reason, which goes into the permanent record. ' +
      'Possible once per close. Ask the user before doing this — it unlocks books somebody deliberately shut.',
    inputSchema: {
      type: 'object',
      properties: { seq: { type: 'integer' }, reason: { type: 'string' }, actor: { type: 'string' } },
      required: ['seq', 'reason'], additionalProperties: false,
    },
  },
  {
    name: 'postledger_read_statement',
    description:
      'Parse a bank/card statement CSV into candidate transactions. NOTHING IS POSTED.\n\n' +
      'A statement line tells you money moved and roughly why. It does not tell you which account the ' +
      'other side belongs to — that is your judgement, which is why this hands the rows back instead of ' +
      'guessing with a rules table.\n\n' +
      'Each candidate carries a suggested_key and an already_posted flag. Use suggested_key as the ' +
      'idempotency_key when you post it, so re-importing the same statement is a no-op.\n\n' +
      'It refuses to guess two things: an ambiguous date like 03/04/2026 (pass date_format), and the ' +
      'sign convention on card statements (pass invert_sign). Guessing either one silently corrupts ' +
      'every row in the file.',
    inputSchema: {
      type: 'object',
      properties: {
        csv: { type: 'string', description: 'The file contents' },
        date: { type: 'string', description: 'Column name (or index) holding the date' },
        amount: { type: 'string', description: 'Single signed amount column' },
        debit: { type: 'string', description: 'Or: money-out column' },
        credit: { type: 'string', description: 'Or: money-in column' },
        description: { type: 'string' },
        reference: { type: 'string', description: 'Bank reference / FITID column. Map it if present — a ' +
          'real reference identifies a row far better than a hash of its contents.' },
        date_format: { type: 'string', enum: ['dmy', 'mdy', 'ymd'] },
        invert_sign: { type: 'boolean', description: 'True when a positive number means money LEAVING (typical of card statements)' },
        delimiter: { type: 'string' },
        has_header: { type: 'boolean', default: true },
      },
      required: ['csv', 'date', 'description'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'postledger_periods',
    description: 'Every period close, including reopened ones, and how far the books are currently closed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'postledger_actors',
    description:
      'Who has written to this book, with entry counts. NOTE: actor is self-declared, not authenticated — ' +
      'useful for tracing accidents, not for catching an adversary.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },

  // ---- write ----------------------------------------------------------------
  {
    name: 'postledger_open_account',
    description:
      'Create an account. Use a colon-separated path with no spaces: "Assets:Bank:Checking", "Expenses:Meals". ' +
      'The first segment conventionally matches the type. Do this deliberately — do not open accounts on the fly ' +
      'just because a posting failed.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Colon:Separated:Path, no spaces' },
        type: { type: 'string', enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
        allow_negative: { type: 'boolean',
          description: 'Whether this account may hold a negative balance. Omit to take the sensible ' +
            'default for the type: asset accounts may NOT go negative (a bank account below zero is ' +
            'almost always a missing entry, not an overdraft), every other type may. This is enforced ' +
            'by the database at post time, not merely recorded.' },
        note: { type: 'string' },
      },
      required: ['account', 'type'],
      additionalProperties: false,
    },
  },
  {
    name: 'postledger_post_entry',
    description:
      'Post a balanced journal entry. This is the only way to write to the books.\n\n' +
      'RULES:\n' +
      '• Debits must equal credits. Leg amounts are always POSITIVE — express direction with side, not a minus sign.\n' +
      '• expected_total is the debit-side total, computed independently by you. If it disagrees with the legs, ' +
      'the entry is rejected. This gate exists to catch a missing or duplicated line before it reaches the books.\n' +
      '• Post only what the source document actually says. Do NOT invent a counterparty, a date, or a line item. ' +
      'If a field is unknown, ask — do not fill it in.\n' +
      '• Accounts must already exist. If one does not, you will get suggestions back; pick from those or open ' +
      'the account deliberately.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string', description: IDEM_DESC },
        date: { type: 'string', description: 'Business date, YYYY-MM-DD. Not "today", not "Aug 8".' },
        description: { type: 'string', description: 'What actually happened, from the source document.' },
        legs: {
          type: 'array', minItems: 2,
          description: 'At least one debit and one credit.',
          items: {
            type: 'object',
            properties: {
              account: { type: 'string' },
              side: { type: 'string', enum: ['debit', 'credit'] },
              amount: { type: 'string', description: AMOUNT_DESC },
              memo: { type: 'string' },
              tax_code: { type: 'string',
                description: 'The tax code that applied AT THE TIME, e.g. "VAT21". Recorded, never computed with. ' +
                  'Pin it now — one expense account can carry legs at several rates, so it cannot be ' +
                  'reconstructed later, and postings are immutable.' },
              tax_amount: { type: 'string', description: 'Tax portion of this leg. ' + AMOUNT_DESC },
              fx_currency: { type: 'string', description: 'Currency this amount was converted FROM, e.g. "EUR". Give with fx_amount.' },
              fx_amount: { type: 'string', description: 'The original amount in that currency. ' + AMOUNT_DESC },
            },
            required: ['account', 'side', 'amount'],
            additionalProperties: false,
          },
        },
        expected_total: { type: 'string', description: 'Debit-side total you computed yourself. ' + AMOUNT_DESC },
        tags: { type: 'object', additionalProperties: { type: 'string' },
          description: 'Labels orthogonal to the chart of accounts: {"project":"apollo","client":"acme"}. ' +
            'Use these instead of forking the account tree into Expenses:Meals:ProjectA. ' +
            'They are covered by the entry hash, so they CANNOT be added or changed afterwards — ' +
            'set them now or never.' },
        actor: { type: 'string', description: 'Who is posting, e.g. "agent:claude". Recorded as a CLAIM, not verified.' },
        dry_run: { type: 'boolean',
          description: 'Run every check and the real write, then roll it back. Nothing is stored and the ' +
            'idempotency key is NOT consumed, so the same key is still available for the real call. ' +
            'The returned entry_id belongs to a rolled-back transaction — never reuse it.' },
        expect_balance_after: {
          type: 'object',
          description: 'Optional stronger assertion: what one account should total after this entry. ' +
                       'Catches posting to the wrong account or the wrong side.',
          properties: { account: { type: 'string' }, balance: { type: 'string', description: AMOUNT_DESC } },
          required: ['account', 'balance'],
          additionalProperties: false,
        },
      },
      required: ['idempotency_key', 'date', 'description', 'legs', 'expected_total'],
      additionalProperties: false,
    },
  },
  {
    name: 'postledger_reverse_entry',
    description:
      'Reverse an entry. This is the ONLY way to correct the books — entries are never edited or deleted. ' +
      'The reversal is a new entry with the opposite legs, so both the mistake and the correction stay visible.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string' },
        idempotency_key: { type: 'string', description: IDEM_DESC },
        reason: { type: 'string', description: 'Why. This goes into the permanent record.' },
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        actor: { type: 'string' },
      },
      required: ['entry_id', 'idempotency_key', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'postledger_revert_actor',
    description:
      'Reverse EVERY entry written by one actor — the recovery path for an agent that went wrong or a batch ' +
      'posted to the wrong book. Reverses, never deletes: the books end up as if that actor never wrote, while ' +
      'the full history of what happened stays intact.\n' +
      'ALWAYS run with dry_run:true first and show the user what would change. Only apply after they confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: { type: 'string', description: 'Exact actor string, from postledger_actors' },
        idempotency_key: { type: 'string', description: 'Batch key. Re-running with the same key safely resumes.' },
        reason: { type: 'string' },
        since: { type: 'string', description: 'YYYY-MM-DD, only entries on or after' },
        until: { type: 'string', description: 'YYYY-MM-DD, only entries on or before' },
        dry_run: { type: 'boolean', default: true, description: 'Preview what would be reversed. Do this first.' },
      },
      required: ['actor', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'postledger_attach_document',
    description:
      'Archive a source document (invoice, receipt, contract, bank slip) and bind it to an entry. ' +
      'Content-addressed by SHA-256: the same file is stored once and never overwritten. ' +
      'postledger_verify later re-hashes the file on disk, so a swapped original is detectable.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string' },
        file_path: { type: 'string', description: 'Absolute path to a file on this machine' },
        kind: { type: 'string', enum: ['invoice', 'receipt', 'contract', 'statement', 'bank_slip', 'other'] },
        idempotency_key: { type: 'string', description: IDEM_DESC },
      },
      required: ['entry_id', 'file_path', 'kind', 'idempotency_key'],
      additionalProperties: false,
    },
  },
] as const;

type Handler = (L: Ledger, args: any) => unknown;

const HANDLERS: Record<string, Handler> = {
  postledger_manual: (_L, a) => manual(a?.topic),
  postledger_chart: (L) => ({ ok: true, currency: L.currency.code, accounts: L.accounts() }),
  postledger_balance: (L, a) => (a.prefix !== undefined
    ? L.balanceTree(a.prefix)
    : L.balance(a.account, { asOf: a.as_of, subtree: a.subtree })),
  postledger_trial_balance: (L) => L.trialBalance(),
  postledger_balance_sheet: (L, a) => L.balanceSheet(a?.as_of),
  postledger_income_statement: (L, a) => L.incomeStatement(a ?? {}),
  postledger_list_entries: (L, a) => L.entries({
    account: a?.account, since: a?.since, until: a?.until, actor: a?.actor,
    describes: a?.describes, tag: a?.tag, tagValue: a?.tag_value, taxCode: a?.tax_code,
    minAmount: a?.min_amount, maxAmount: a?.max_amount,
    beforeSeq: a?.before_seq, limit: a?.limit,
  }),
  postledger_verify: (L) => L.verify(),
  postledger_audit: (L, a) => L.auditSignals(a ?? {}),
  postledger_actors: (L) => L.actors(),
  postledger_close_period: (L, a) => L.closePeriod(a.name, a.as_of, { actor: a.actor, note: a.note }),
  postledger_reopen_period: (L, a) => L.reopenPeriod(a.seq, a.reason, { actor: a.actor }),
  postledger_periods: (L) => L.periods(),
  postledger_read_statement: (L, a) => L.readStatement(a.csv, {
    date: a.date, amount: a.amount, debit: a.debit, credit: a.credit,
    description: a.description, reference: a.reference,
    dateFormat: a.date_format, invertSign: a.invert_sign,
    delimiter: a.delimiter, hasHeader: a.has_header !== false,
  }),
  postledger_assert_balance: (L, a) => L.assertBalance(a.account, a.amount,
    { subtree: a.subtree, note: a.note, actor: a.actor }),
  postledger_list_assertions: (L, a) => L.assertions(a ?? {}),
  postledger_stale_assertions: (L, a) => L.staleAssertions({ withinDays: a?.days }),
  postledger_ageing: (L, a) => L.ageing(a.account, { asOf: a.as_of }),
  postledger_allocate: (L, a) => L.allocate(a.amount, a.ratios),
  postledger_convert: (L, a) => L.convert(a.amount, a.from, a.rate, { to: a.to }),

  postledger_open_account: (L, a) =>
    L.openAccount(a.account, a.type, { allowNegative: a.allow_negative, note: a.note }),

  postledger_post_entry: (L, a) =>
    L.post({
      idempotencyKey: a.idempotency_key, date: a.date, description: a.description,
      legs: (a.legs ?? []).map((l: any) => ({
        account: l.account, side: l.side, amount: l.amount, memo: l.memo,
        taxCode: l.tax_code, taxAmount: l.tax_amount,
        fxCurrency: l.fx_currency, fxAmount: l.fx_amount,
      })),
      expectedTotal: a.expected_total, actor: a.actor, tags: a.tags,
      expectBalanceAfter: a.expect_balance_after,
    }, { dryRun: a.dry_run === true }),

  postledger_reverse_entry: (L, a) =>
    L.reverse(a.entry_id, { idempotencyKey: a.idempotency_key, reason: a.reason, date: a.date, actor: a.actor }),

  postledger_revert_actor: (L, a) =>
    L.revertActor(a.actor, {
      // dry_run defaults to true: this operation has a big blast radius, so preview is mandatory by default
      idempotencyKey: a.idempotency_key ?? '', reason: a.reason,
      since: a.since, until: a.until, dryRun: a.dry_run !== false,
    }),

  postledger_attach_document: (L, a) =>
    L.attach(a.entry_id, a.file_path, a.kind, { idempotencyKey: a.idempotency_key }),
};

// ---------------------------------------------------------------------------

export async function runMcpServer(bookPath: string): Promise<void> {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const failRpc = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  // Tool-execution failures don't go through JSON-RPC error — they come back
  // as a normal result with isError set, so the model gets a structured hint
  // it can act on and retry, instead of an opaque RPC failure.
  const toolError = (id: unknown, payload: unknown) =>
    reply(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true });

  const rl = createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;

    let msg: any;
    try { msg = JSON.parse(raw); }
    catch { failRpc(null, -32700, 'parse error'); continue; }

    const { id, method, params } = msg;

    try {
      switch (method) {
        case 'initialize':
          reply(id, {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'postledger', version: VERSION },
            instructions: INSTRUCTIONS,
          });
          break;

        case 'notifications/initialized':
          break;                                  // Notifications get no reply

        case 'tools/list':
          reply(id, {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: {
                readOnlyHint: !!(t as any).readOnly,
                destructiveHint: t.name === 'postledger_revert_actor',
                idempotentHint: !(t as any).readOnly,
              },
            })),
          });
          break;

        case 'tools/call': {
          const name = params?.name;
          const handler = HANDLERS[name];
          if (!handler) { failRpc(id, -32602, `unknown tool: ${name}`); break; }

          // Open a fresh connection per call: SQLite connections are cheap, and this avoids a long-lived connection holding a lock
          const L = Ledger.open(bookPath);
          try {
            const out = handler(L, params?.arguments ?? {});
            reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
          } catch (e: any) {
            if (e instanceof PostledgerError) toolError(id, e.toJSON());
            else toolError(id, { ok: false, error_code: 'INTERNAL', error: String(e?.message ?? e),
                                 hint: 'This is a bug in postledger, not in your call. Report it with the arguments you used.' });
          } finally {
            L.close();
          }
          break;
        }

        case 'resources/list':
          reply(id, {
            resources: MANUAL.map((m) => ({
              uri: `postledger://manual/${m.topic}`,
              name: m.topic,
              description: m.summary,
              mimeType: 'application/json',
            })),
          });
          break;

        case 'resources/read': {
          const uri = String(params?.uri ?? '');
          const topic = uri.replace('postledger://manual/', '');
          const doc = manual(topic);
          if (!doc.ok) { failRpc(id, -32602, `unknown manual topic: ${topic}`); break; }
          reply(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(doc, null, 2) }] });
          break;
        }

        case 'ping':
          reply(id, {});
          break;

        default:
          if (id !== undefined) failRpc(id, -32601, `method not found: ${method}`);
      }
    } catch (e: any) {
      if (id !== undefined) failRpc(id, -32603, String(e?.message ?? e));
    }
  }
}
