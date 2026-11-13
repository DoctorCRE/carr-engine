# The new database

The engine will move to a new, cleanly connected database in one planned step, after it serves every screen from today's database. This note designs the core. `schema/next.sql` holds the first slice. Tests load it into its own namespace in a throwaway database with made-up data. Nothing applies it to a live database.

## Records

- **`party`**: every person and company, once, each with its own id. `kind` is `person` or `company`.
- **`role`**: the short list of roles, such as client, lead, vendor, lender, listing agent and property owner. The partners can rename a label without touching any record.
- **`property`**: a building or space, by address.
- **`deal`**: one piece of brokerage work.
- **`offer`**: one round of an LOI or other offer on a deal.
- **`document`**: a file, as its name and its key in object storage (Cloudflare R2). The file itself is never in the database.

## Links

Each link is one row. No record holds a list or a column per role.

- **`party_role`**: what a person or company is to us. One row per role.
- **`deal_party`**: who is on a deal, in which role. The client, the listing agent and each vendor are rows here.
- **`deal_property`**: the properties a deal is considering.
- **`offer_document`**: the documents of each round.

## Rules the database enforces

Each rule has a test in `src/next-database.test.ts` that fails without it.

1. A link to a record that does not exist is refused, and so is deleting a record something still links to.
2. Every role on a person or a deal comes from the role list.
3. The same link is stored once.
4. A person or company is one of the two kinds.
5. A round's number is used once per deal, and a round answers an earlier round of the same deal.
6. A round comes from someone on the deal, in their role on that deal, about a property the deal is considering.
7. A round is never rewritten or removed. Only its status changes. New terms are the next round, and `withdrawn` takes a round back.
8. At most one round per deal is accepted.
9. Rent, term, TI and free rent are never negative.

Two people adding different links to one deal at the same time both keep theirs, because each link is its own row. A test proves it with two open sessions.

## Offer rounds

Every LOI, counter and response is a new `offer` row. It holds its round number, the round it answers, who sent it and in what role, when, and its status: `open`, `countered`, `accepted`, `rejected` or `withdrawn`. The standard terms are typed columns, so the app can show what changed from one round to the next: rent per square foot per year, term in months, TI per square foot, free rent months, yearly escalation percent and commencement date.

`everything_about_deal` returns a deal's properties, its people with their roles, and its rounds in order with their documents, in one read. The property reaches the deal through `deal_property`, and the client and the listing agent through `deal_party`.

## Owner decision: unusual one-off terms

Some LOIs carry a term no other deal has, such as an exclusive-use clause. There are two ways to keep it:

- **A plain text field on each round.** This is built and recommended. It keeps one place, is easy to read, and the document holds the exact wording.
- **A row per extra term**, each with a name and a value. Each term could then be compared round to round, at the cost of another table and a name for every term.

Unusual terms are rare and are read by people, not computed, so the text field is enough.

## Owner decision: how a round's status may change

Today a round's status can move from any value to any other, such as from accepted back to open. The recommendation is to allow only these moves: open to countered, accepted, rejected or withdrawn, and nothing out of countered, accepted, rejected or withdrawn. A mistaken status would then be fixed by a new round, as a mistaken term is.

## Next slice (#196): activity, emails and next steps

- **`activity`**: something that happened: an email, a call, a meeting or a note, with when and who it came from. **`activity_about`** links it to each deal, person or property it concerns, one row each, exactly one record per row. One email about a deal, its client and its lender shows on all three timelines.
- **`email`**: the email behind an email activity. It holds the mailbox's message id, unique so the same message is never stored twice, plus the sender, the subject and the new text only, with quoted history removed. The date is the activity's time. The agent stores only an email it ties to a record. Mail that matches nothing stays in the mailbox and is not copied, and the database refuses an email that is about no record. The original mailbox stays the full record.
- **Attachments** go to R2. Each becomes a `document` that names the email activity it arrived with.
- **`next_step`**: what is due next, about exactly one deal, person or property.

Size, as reasoning: a stored email is a few kilobytes of plain text, without attachments or quoted history, and only mail about a record is kept. So the table grows with deal work, not with mailbox traffic. Files grow in R2.

## Worked example: an LOI response by email

The partners toured 100 Example Way with their client and sent an LOI. The listing agent emails back with a counter.

1. The client and the listing agent are each a `party`, with `party_role` rows for client and listing agent.
2. The property is a `property`, linked to the deal by `deal_property`.
3. On the deal, `deal_party` holds the client as client and the agent as listing agent.
4. Our LOI is round 1, sent by the client.
5. The agent's email becomes an `activity` from the agent, with its `email` row and an `activity_about` row for the deal (next slice).
6. The attached PDF goes to R2 and becomes a `document`.
7. The counter is round 2. It comes from the agent as listing agent, answers round 1, carries its own terms, and links the PDF in `offer_document`. Round 1 becomes countered.
8. Our response is round 3. The agent's acceptance marks it accepted.
9. A `next_step` on the deal says to start the lease draft (next slice).

The tests run rounds 1 to 3 and the acceptance, and read them back in order.

## Later slices

Partners as people, and who changed what. Deal phase, type, owner and dates. Emails and phone numbers per person. People at companies. Merging duplicates. "Everything about this person." Leads and their conversion to clients. National accounts and franchisees. Leases, critical dates and commissions. Change history. Indexes, once real sizes are known. Moving today's records across, where the old party kind `org` becomes `company`.
