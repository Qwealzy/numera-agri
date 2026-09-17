# These migrations are applied history, not an install path

**To create a new database, apply `../schema.sql`.** That is the only
supported install path, and it is verified to apply to an empty database on
its own as part of every change to it.

**The files in this directory bring an EXISTING database forward.** Run the
ones a given database has not had yet, in order. They are the record of how
this schema actually changed, one decision at a time, and several carry
reasoning in their comments that `schema.sql` has no room for.

## They cannot be replayed from nothing

`001_stage1_outbox_and_policyholder_party.sql` fails on its first
`CREATE TABLE` against an empty database — `relation "policies" does not
exist` — because it expects the schema that predates the outbox. Its own
header says so: *"Run against a database that already has schema.sql + the
round-8 migration applied."* Neither that earlier `schema.sql` nor the
round-8 migration is in this repository, and the string `round-8` appears
exactly once in the whole tree — in that sentence.

Demonstrate it rather than taking it on trust:

```bash
node scripts/checkMigrationBase.mjs
```

It applies both paths to throwaway databases and drops them afterwards.

## Why no base was reconstructed

Much of one could be recovered — `schema.sql` minus what these files add,
plus the `USING` mappings in 004 and 005, which record the pre-Stage-1 enum
values and casing exactly, plus `eft_transactions`, still in git history. What could not be recovered is the round-8 migration's content and
the exact types, defaults and constraints of the columns dropped before this
repository was under version control.

But recoverability is not what decided it. **A faithful base would have to
contain a `policyholders.iban` column and the `eft_transactions` table**,
because 001 drops the first and 015 drops the second. That means committing
both back into the tree as SQL a fresh install would create and immediately
delete — against a standing rule that this platform holds no account
numbers and instructs no payments, and neither may exist here. A base that
omitted them would not be the original; it would be a guess wearing the
original's name, and a wrong base is worse than a missing one.

## Writing a new one

- Pair every `schema.sql` change with a numbered migration, and vice versa —
  they are kept equal by hand.
- After mirroring, verify `psql -v ON_ERROR_STOP=1 -f sql/schema.sql` still
  applies to a fresh throwaway database in silence, then that `seed.sql` does
  too.
- `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that
  later reads the new value, which is why some of these files are split the
  way they are. It also appends, so the enum sort order here diverges from
  `schema.sql`'s declared order; that is recorded at the `CREATE TYPE` lines
  and guarded by `node/test/enumOrdering.test.mjs`.
