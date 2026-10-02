-- The application's least-privileged login role and its grants.
--
-- Not part of schema.sql and not a migration: it creates a cluster-wide role
-- and grants on one database, and is applied per database by the maintenance
-- user (the owner of the tables, today postgres), never by the role itself.
-- Three psql variables are required:
--
--   app_role      the role's name, e.g. insurance_app
--   app_password  its password, used only when the role does not exist yet;
--                 an existing role is skipped and its password left as it is
--   mode          working  the database the application writes (DATABASE_URL)
--                 test     the database npm test writes (TEST_DATABASE_URL)
--
--   psql -v ON_ERROR_STOP=1 -v app_role=insurance_app -v app_password=... -v mode=working -d insurance -f sql/roles.sql
--   psql -v ON_ERROR_STOP=1 -v app_role=insurance_app -v app_password=... -v mode=test -d insurance_test -f sql/roles.sql
--
-- Safe to apply again: the role is created only when missing and GRANT is
-- idempotent.
--
-- Tables are named one by one, never ON ALL TABLES: a table added later gets
-- no grant until someone gives it one on purpose, and `npm run doctor`
-- reports the table the connected role cannot read or write.

\set ON_ERROR_STOP on

SELECT :'mode' IN ('working', 'test') AS mode_known, :'mode' = 'test' AS mode_test \gset
\if :mode_known
\else
DO $$ BEGIN RAISE EXCEPTION 'sql/roles.sql: -v mode must be working or test'; END $$;
\endif

-- DO bodies cannot see psql variables, so the two values reach the block
-- through settings local to this session.
SELECT set_config('roles_sql.app_role', :'app_role', false),
       set_config('roles_sql.app_password', :'app_password', false) \gset roles_sql_

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_setting('roles_sql.app_role')) THEN
    RAISE NOTICE 'role % exists, not created', current_setting('roles_sql.app_role');
  ELSE
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE',
                   current_setting('roles_sql.app_role'), current_setting('roles_sql.app_password'));
  END IF;
END
$$;

SELECT set_config('roles_sql.app_password', '', false) \gset roles_sql_

-- Section A, every database: what node/src needs.
GRANT USAGE ON SCHEMA public TO :"app_role";

GRANT SELECT ON
  insurers, policyholders, payout_tiers, policies, policy_coverages, oracle_raw_responses, attested_evidence,
  oracle_readings, trigger_windows, policy_events, policy_documents, policy_status_history, payout_events,
  payout_notifications
  TO :"app_role";

-- Every table but policy_documents, which node/src only reads.
GRANT INSERT, UPDATE ON
  insurers, policyholders, payout_tiers, policies, policy_coverages, oracle_raw_responses, attested_evidence,
  oracle_readings, trigger_windows, policy_events, policy_status_history, payout_events,
  payout_notifications
  TO :"app_role";

-- The two DELETEs: the dispatcher's coverage replacement (dispatcher.js), and
-- the tier-set PUT and DELETE (routes/policies.js).
GRANT DELETE ON policy_coverages TO :"app_role";
GRANT DELETE ON payout_tiers TO :"app_role";

GRANT USAGE ON SEQUENCE policy_status_history_id_seq TO :"app_role";

-- Section B, the test database only: the tests' teardowns delete from every
-- table. attested_evidence still refuses unless the database is marked
-- (migration 032).
\if :mode_test
GRANT SELECT, INSERT, UPDATE, DELETE ON
  insurers, policyholders, payout_tiers, policies, policy_coverages, oracle_raw_responses, attested_evidence,
  oracle_readings, trigger_windows, policy_events, policy_documents, policy_status_history, payout_events,
  payout_notifications
  TO :"app_role";
\endif
