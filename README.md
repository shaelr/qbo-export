# qbo-export

A command-line tool that copies **all of your QuickBooks Online data** (Canadian
edition) into a folder on your own computer, then **checks the copy** against
QuickBooks' own reports.

**It is read-only.** It never creates, changes or deletes anything in
QuickBooks:

- It only ever sends `GET` (read) requests to your company.
- Any other kind of request is refused in code before it can be sent.
- It asks Intuit only for the `com.intuit.quickbooks.accounting` scope. That
  means no payments, payroll or profile access.

| Command | What it does |
| --- | --- |
| `npm run qbo -- auth` | One-time connection to your QuickBooks company. |
| `npm run qbo -- whoami` | Shows which company is connected. |
| `npm run qbo -- export --out <folder>` | Exports everything, downloads attachments, and writes the verification report. |
| `npm run qbo -- verify --out <folder>` | Re-checks an existing archive and rewrites its report. |
| `npm run qbo -- query "select …"` | Runs one read-only query, for troubleshooting. |

---

## Setup

### Requirements

- macOS (also works on Linux) with **Node.js 22.18 or newer**
- A free Intuit Developer account: <https://developer.intuit.com>

```sh
npm install
cp .env.example .env
```

### 1. Create the Intuit app (one time)

1. Sign in at <https://developer.intuit.com> → **My Hub → App dashboard** →
   create an app for **QuickBooks Online**. Choose the **Accounting** scope
   only.
2. Intuit creates a **sandbox company**. This is fake practice data, not your
   books. Optionally add a Canadian one under
   **My Hub → Sandboxes → Add → Canada**.

### 2. Sandbox: try it on practice data first

1. Open your app → **Keys and credentials** (sometimes called **Settings**) →
   **Development**.
2. Put the **Client ID** and **Client Secret** in `.env`:
   ```
   QBO_ENVIRONMENT=sandbox
   QBO_CLIENT_ID=...
   QBO_CLIENT_SECRET=...
   ```
   You can instead put each one in a file and set `QBO_CLIENT_ID_FILE` /
   `QBO_CLIENT_SECRET_FILE`.
3. Under **Redirect URIs** (Development), add exactly:
   `http://localhost:8765/callback`. Use `http`, port `8765`, and no trailing
   slash.
4. Connect and check:
   ```sh
   npm run qbo -- auth      # browser opens; pick the sandbox company; choose a passphrase
   npm run qbo -- whoami
   ```

### 3. Production: your real company

Your sandbox keys only work with sandbox companies. For your real books you
need **production keys**, and Intuit has two rules about them:

- **Production keys are gated.** Intuit asks for app details and a short
  questionnaire before showing them, even for a private app. Describe it as a
  private, read-only tool that backs up your own company's data.
- **Production redirect URIs must be HTTPS and can't be `localhost`.** So the
  tool uses Intuit's own Playground page as the redirect, and you paste the URL
  back into the terminal.

Steps:

1. **Keys and credentials → Production**: add the Redirect URI
   `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`
2. In `.env`: set `QBO_ENVIRONMENT=production` and the **production** Client
   ID and Secret.
3. Run `npm run qbo -- auth`:
   - Open the printed link, sign in with your normal QuickBooks login, choose
     your company and click **Connect**.
   - You'll land on an Intuit page. Copy the **entire address-bar URL** (it
     contains `code=` and `realmId=`) and paste it into the terminal **right
     away**, because it expires within minutes.
4. Run `npm run qbo -- whoami`. It should show your company with
   `Country: CA`.

Sandbox and production tokens are stored separately, so switching never mixes
them up.

---

## Running the export

```sh
npm run qbo -- export --out ~/QuickBooks-Archive
```

> **Store the archive on an encrypted disk.** It contains your customers,
> invoices, bank details on cheques, and receipt images. On a Mac, run
> `fdesetup status`. If it says *FileVault is On*, your home folder is
> encrypted. Otherwise use an encrypted external drive or an encrypted disk
> image (Disk Utility → File → New Image → Encryption: 256-bit AES). Each
> archive contains a `.gitignore` with `*`, so it can't be committed to git by
> accident.

### What gets exported

Every record goes to `raw/<Entity>/<Id>.json`, **exactly as QuickBooks returned
it**:

- Every field is kept.
- Money keeps its exact digits (`1130.10` stays `1130.10`); it is never
  converted to floating point.
- Files are only indented for readability.

**Inactive** customers, vendors, items and accounts are included, because old
transactions refer to them.

| Group | Entities |
| --- | --- |
| Company | CompanyInfo (fiscal year, address, tax registration), Preferences |
| Lists | Account, Customer, Vendor, Employee, Item, Term, PaymentMethod, Class, Department (Locations), TaxCode, TaxRate, TaxAgency |
| Sales | Invoice (including voided), CreditMemo, Estimate (status and the invoice it became), Payment, SalesReceipt, RefundReceipt |
| Expenses | Purchase (cash, cheque and credit-card expenses), Bill, BillPayment, VendorCredit, PurchaseOrder, CreditCardPayment |
| Banking and ledger | Deposit, Transfer, JournalEntry, TimeActivity |
| Attachments | Attachable (metadata), plus the files themselves |

On **QuickBooks Essentials**, Classes, Locations and Purchase Orders don't
exist. They're reported as **skipped**, which is expected and not an error.

**Spreadsheet copies for your accountant** go in `csv/`:

- `invoices.csv`: status (Paid, Partially paid, Open, Voided), HST, and links
  to the estimate and payments
- `invoice_lines.csv`
- `estimates.csv`: status, and the invoice each was converted into
- `expenses.csv`: one row per expense line, with category, HST code and payee
- `customers.csv`, `vendors.csv`, `items.csv`
- `attachments.csv`

They open cleanly in Excel. They're rebuilt from the whole archive on every
run. The raw JSON remains the source of truth.

### Receipts and attachments

**Files attached to a transaction** (expenses, bills, invoices and so on) are
downloaded to `attachments/<attachableId>/<original filename>`:

- **Fresh link:** right before each file, the tool asks QuickBooks for a fresh
  temporary download link. Your QuickBooks token is never sent to the file
  server.
- **Checks:** each file's SHA-256 checksum and size are recorded, and the size
  is checked against QuickBooks. A cut-off download is retried. A file whose
  size never matches is **kept and flagged**, not discarded.
- **Links:** `attachments.csv` and `manifest.json` show what each file is
  attached to, e.g. `Invoice 1037 (#130)`.

**Unlinked files** are receipts in the Receipts inbox **For review** list, or
the leftover originals of receipts you already reviewed:

- Their records are archived, but the files are **not downloaded unless you
  add `--include-unlinked`**.
- **Two copies after review:** when you review a receipt, QuickBooks keeps the
  original upload as an unlinked attachment *and* adds an identical copy on
  the expense.
- **Processing delay:** a freshly uploaded receipt takes up to a minute or so
  to appear in the API. Wait a few minutes after uploading before a final
  export.

---

## Reading the verification report

Every export ends with a check, written to `report/verification.md`. Open it in
VS Code (preview) or any Markdown viewer. The same data is in
`verification.json`.

- **All checks passed** means every check below passed.
- **N items need attention** means each item is listed at the top of the
  report.

| Section | What it checks | What "good" looks like |
| --- | --- | --- |
| **1. Record counts** | Records fetched for each type vs QuickBooks' own `count(*)`. | ✅ on every row. "Skipped" is fine for plan-gated features. |
| **2. Attachments** | Found, downloaded, already archived and re-verified, failed, size mismatches, unlinked, total bytes. | Failed = 0. |
| **3. Yearly totals vs Profit & Loss** | For each fiscal year: income (invoices + sales receipts − credit memos − refunds) and expenses (expenses + bills − vendor credits), **net of HST**, compared with QuickBooks' P&L on your books' basis (accrual). | ✅ *match* or ✅ *reconciled*. |
| **4. P&L transactions found in the archive** | Every transaction listed in QuickBooks' P&L Detail report exists in the archive. | Missing = 0. |
| **5. Accounts receivable** | Open invoice balances − unapplied credits − unapplied payments, vs the **A/R Aging** report total as of today. | ✅ *match*. |
| **6. Deleted records** | Deletions QuickBooks reports in its change feed, and whether the archive has a copy. | "kept", or "deleted before the first export" (informational: nothing could have saved it). Only records deleted *between* exports before being captured are flagged. |
| **7. Failures and skipped items** | Everything that failed or was skipped, with the reason. | Only expected skips. |

**Section 3 statuses:**

- **match:** the archive total equals the P&L exactly.
- **reconciled:** they differ, but entirely because of known items:
  - journal entries posting to income or expense accounts, e.g. depreciation;
  - deposits recorded straight to an income or expense account, e.g. interest;
  - expense lines posted to balance-sheet accounts, e.g. buying equipment or
    inventory, loan payments or owner draws. These aren't P&L expenses;
  - expense lines coded to an *income* account, which QuickBooks shows as
    negative income;
  - cost of goods sold on sales of inventory items. This figure is taken from
    QuickBooks' P&L Detail, because the archive has no inventory cost history.

  The *Breakdown by year* table shows each part.
- **difference:** some amount is unexplained. Common causes:
  - billable expenses re-charged on invoices;
  - invoice lines for items mapped to non-income accounts, e.g. deposits or
    retainers;
  - a type that failed to export (see section 1).

  Look at the year's P&L Detail in QuickBooks next to `expenses.csv` /
  `invoices.csv`, or ask your accountant. A difference **doesn't mean data is
  missing**. Section 4 is the direct check for missing transactions.

Counts can differ by one or two if someone edits QuickBooks *during* an export.
Re-run and the numbers settle.

The raw report JSON used for these checks is saved in `report/reports-raw/`.

---

## Re-running safely

You can re-run any command at any time:

- **Interrupted?** Run the same command again. Progress is saved after every
  page (`state/progress.json`), so it continues where it stopped. `--fresh`
  starts over.
- **Already complete?** Running again does a full new pass and updates each
  record to its latest version. **Nothing is ever deleted** from the archive.
- **Attachments** already archived are re-checked by checksum and skipped. They
  are downloaded again only if missing, corrupted, or changed in QuickBooks.
- **Incremental:** `--since 2025-01-01` fetches only records changed since that
  date. The report still covers the whole archive.
- **Just one type:** `--only Invoice,Customer`.
- **Report only:** `npm run qbo -- verify --out <folder>` re-checks without
  exporting.
- **Safety checks:** two exports can't write to one folder at once, and one
  archive can't mix two companies.

---

## Limitations

- **Deleted transactions can't be retrieved.** QuickBooks queries never return
  deleted records. Its change feed reports deletions for the **last 30 days
  only, and only as an ID**, not the contents. What this tool does:
  - Records deleted *after* they were archived are **kept**, and listed as
    "no longer returned by QuickBooks".
  - Records deleted *before* the first export are gone, as far as the API is
    concerned.
  - Every deletion seen is logged in `state/deletions.json`. Running exports
    regularly builds up that history.
- **Unlinked attachments** are only downloaded with `--include-unlinked`.
- **Not part of the Accounting API, so not exported:**
  - payroll;
  - bank-feed transactions still in Banking "For review";
  - reconciliation reports;
  - the audit log;
  - custom report layouts and invoice templates;
  - QuickBooks Payments data.
- **Currency:** totals assume a single home currency (CAD). With
  multi-currency, the report's totals would need home-currency conversion.

---

## Security and privacy

- **Tokens:**
  - Encrypted on disk with your passphrase (scrypt, then AES-256-GCM), at
    `~/Library/Application Support/qbo-export/tokens-<env>.enc.json`,
    readable only by you.
  - You're asked for the passphrase once per run. If you forget it, run
    `auth --reset`; nothing in QuickBooks is affected.
- **Refresh tokens:** Intuit **rotates** them; the old one stops working as
  soon as a new one is issued. The tool saves each new token to disk *before*
  using it. If that save fails, it keeps an encrypted `.recovery` copy, so a
  connection is never lost to a crash.
- **Logs:** `logs/*.jsonl` inside the archive contains entity names, counts and
  Intuit request IDs, **never** tokens, secrets or customer details.
- **Keep secrets out of git:** don't commit `.env`. The project `.gitignore`
  already excludes it, along with token files and archives.

## Archive layout

```
<archive>/
  .gitignore                    "*", so the archive is never committed
  manifest.json                 schema version, tool version, realm ID, timestamps,
                                per-entity counts, attachment checksums and links
  raw/<Entity>/<Id>.json        untouched QuickBooks records (the source of truth)
  attachments/<id>/<filename>   receipt images and other files
  csv/*.csv                     spreadsheet copies
  report/verification.md|json   verification report
  report/reports-raw/           QuickBooks report JSON used by the checks
  state/                        progress checkpoints, attachment state, deletion history
  logs/                         run logs (no secrets or customer data)
```

## Troubleshooting

| Message | Fix |
| --- | --- |
| `redirect_uri is invalid` (in the browser) | The Redirect URI on the Intuit Keys page must match `.env` exactly. It must also be on the matching Development or Production tab. |
| `QuickBooks authorization is no longer valid` | The connection was revoked or expired. Run `npm run qbo -- auth` again. |
| `Could not decrypt the token store` | Wrong passphrase. Try again, or run `auth --reset` and reconnect. |
| `This archive belongs to company …` | You're connected to a different company than this folder holds. Use another `--out` folder. |
| `Another export is already running` | Wait for it to finish. If it crashed, just run again, since stale locks are cleared automatically. |
| Slow, or "throttled" warnings | Normal. The tool stays under Intuit's limit of 500 requests per minute and backs off when asked. |

## Development

```sh
npm test            # unit tests: no network; fixtures shaped like sandbox responses
npm run typecheck
```

Optional settings (`.env`): `QBO_MINOR_VERSION` (default 75), `QBO_STATE_DIR`,
`QBO_LOG_LEVEL` (console log level, default `warn`).
