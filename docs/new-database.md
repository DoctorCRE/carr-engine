# The new database

The engine will move to a new, cleanly connected database in one planned step, after it serves every screen from today's database. This note designs the core. `schema/next.sql` holds the first slice. Tests load it into its own namespace in a throwaway database with made-up data. Nothing applies it to a live database.

## Records

- **`party`**: every person and company, once, each with its own id. `kind` is `person` or `company`.
- **`role`**: the short list of roles, such as client, lead, vendor, lender, listing agent and property owner. The partners can rename a label without touching any record.
- **`property`**: a building or space, by address.
- **`deal`**: one piece of brokerage work.
- **`phase`**: the list of deal phases, from negotiating to closed, plus dead. Like roles, a label can be renamed.
- **`deal_phase_change`**: one row each time a deal changes phase, with when, the new phase and the reason. A deal's phase is its latest row.
- **`offer`**: one round of an LOI or other offer on a deal.
- **`document`**: a file, as its name and its key in object storage (Cloudflare R2). The file itself is never in the database. An email attachment names the email it arrived with.
- **`activity`**: something that happened: an email, a call, a meeting or a note, with when, who it came from and a summary.
- **`email`**: the email behind an email activity.
- **`next_step`**: what is due next, with its owner, due date and the time it was done.

## Links

Each link is one row. No record holds a list or a column per role.

- **`party_role`**: what a person or company is to us. One row per role.
- **`party_company`**: a person at a company, with their title there and the dates they started and left. A person who moves keeps the old row, with its end date, and gets a new one.
- **`deal_party`**: who is on a deal, in which role. The client, the listing agent and each vendor are rows here.
- **`deal_property`**: the properties a deal is considering.
- **`offer_document`**: the documents of each round.
- **`activity_about`**: each deal, person or company, or property an activity concerns.

## Rules the database enforces

Each rule has a test in `src/next-database.test.ts` that fails without it.

1. A link to a record that does not exist is refused, and so is deleting a record something still links to.
2. Every role on a person or a deal comes from the role list.
3. The same link is stored once.
4. A person or company is one of the two kinds.
5. A round's number is used once per deal, and a round answers an earlier round of the same deal.
6. A round comes from someone on the deal, in their role on that deal, about a property the deal is considering.
7. A round is never rewritten or removed, not even by emptying the table. Only its status changes. New terms are the next round, and `withdrawn` takes a round back.
8. At most one round per deal is accepted at a time.
9. Rent, NNN, term, TI, free rent, the escalator and days after delivery are never negative.
10. A round's status moves only out of `open`, or from `accepted` to `superseded`. Every other status is final. A round is superseded only when a later round of the same deal is accepted, checked when the change is saved.
11. Rent starts on a date or a number of days after delivery, never both.
12. A person-at-company link joins a person to a company, ends no earlier than it starts, and is stored once.
13. A deal's phase changes are never rewritten or removed, each phase comes from the list, and a move to dead says why.
14. An activity is an email, a call, a meeting or a note. Each `activity_about` row names exactly one deal, party or property, and is stored once.
15. An email's Message-ID is stored once and never has spaces around it, an email belongs to an email activity, and an attachment names an email. An email is about at least one record, checked when the change is saved, so an email about nothing is refused and so is removing, moving or emptying away its last link. Emptying `email` cannot reach a round's documents.
16. A next step is about exactly one deal, party or property.

Two people adding different links to one deal at the same time both keep theirs, because each link is its own row. A test proves it with two open sessions.

## Offer rounds

Every LOI, counter and response is a new `offer` row. It holds its round number, the round it answers, who sent it and in what role, when, and its status: `open`, `countered`, `accepted`, `rejected`, `withdrawn` or `superseded`. The standard terms are typed columns, so the app can show what changed from one round to the next: rent and estimated NNN per square foot per year, term in months, TI per square foot, free rent months, yearly escalation percent, and when rent starts, as a date or as a number of days after delivery. Each later term is one more column.

`everything_about_deal` returns a deal's phase changes in order, its properties, its people with their roles, its rounds in order with their documents, its activity in time order with each email and its attachments, and its next steps by due date, in one read. The property reaches the deal through `deal_property`, and the client and the listing agent through `deal_party`.

## Owner decision: unusual one-off terms

Some LOIs carry a term no other deal has, such as an exclusive-use clause. There are two ways to keep it:

- **A plain text field on each round.** This is built and recommended. It keeps one place, is easy to read, and the document holds the exact wording.
- **A row per extra term**, each with a name and a value. Each term could then be compared round to round, at the cost of another table and a name for every term.

Unusual terms are rare and are read by people, not computed, so the text field is enough.

## When a deal falls apart

A round's status records what happened to that round, and the deal's phase records where the deal stands. An accepted round stays accepted when the deal later dies. The deal moves to the dead phase, with a date and a reason, and nothing is deleted. If talks restart, the deal moves to a live phase again and the new rounds answer the last one. When a new round is accepted, the earlier accepted round becomes `superseded` in the same save, so a deal has one current accepted round. An accepted round is never superseded on its own. A mistaken status is fixed by a new round, as a mistaken term is.

## Activity, emails and next steps

- **`activity`** records something that happened. **`activity_about`** links it to each deal, person or company, or property it concerns, one row each. One email about a deal, its client and its lender shows on all three timelines.
- **`email`** holds the message's own Message-ID header (Outlook's `internetMessageId`), never an id one mailbox gives it, so mail both partners received is stored once. The id is unique, keeps its case, and is refused with spaces around it. The row also holds the sender, the subject and the new text only, with quoted history removed. The date is the activity's time. The agent stores only an email it ties to a record. Mail that matches nothing stays in the mailbox and is not copied, and the database refuses an email that is about no record. The original mailbox stays the full record.
- **Attachments** go to R2. Each becomes a `document` that names the email it arrived with.
- **`next_step`** is about exactly one deal, person or company, or property. Its owner is a party.
- A step with no owner may be a partner's own, because partners become parties only in a later slice.

A row that may point at one of several kinds of record has one checked key per kind and a check that exactly one is set. It never holds a type word and an id the database cannot check (decision 21). Activity and next steps are not history: a note can be corrected, and a step is marked done.

Size, as reasoning: a stored email is a few kilobytes of plain text, without attachments or quoted history, and only mail about a record is kept. So the table grows with deal work, not with mailbox traffic. Files grow in R2.

## Worked example: an LOI response by email

The partners toured 100 Example Way with their client and sent an LOI. The listing agent emails back with a counter.

1. The client and the listing agent are each a `party`, with `party_role` rows for client and listing agent.
2. The property is a `property`, linked to the deal by `deal_property`.
3. On the deal, `deal_party` holds the client as client and the agent as listing agent.
4. Our LOI is round 1, sent by the client.
5. The agent's email becomes an `activity` from the agent, with its `email` row and `activity_about` rows for the deal and the agent.
6. The attached PDF goes to R2 and becomes a `document` that names the email.
7. The counter is round 2. It comes from the agent as listing agent, answers round 1, carries its own terms, and links the PDF in `offer_document`. Round 1 becomes countered.
8. Our response is round 3. The agent's acceptance marks it accepted.
9. A `next_step` on the deal says to start the lease draft.

The tests run rounds 1 to 3, the acceptance, the email with its attachment, a call and the next steps, and read them back in order.

## Later slices

Partners as people, and who changed what. Deal type, owner and dates. Emails and phone numbers per person. Merging duplicates. "Everything about this person." Leads and their conversion to clients. National accounts and franchisees. Leases, critical dates and commissions. Change history. Indexes, once real sizes are known. Moving today's records across, where the old party kind `org` becomes `company`.
