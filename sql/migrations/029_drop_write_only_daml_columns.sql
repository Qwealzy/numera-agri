-- 029: daml_template_id and daml_policy_key were write-only. Both were
-- written by dispatcher.js -- once in handleActivation, once in the renewal
-- handler -- and read back by nothing: no SELECT anywhere in the repository,
-- and no index, constraint, view or function in the working database's
-- catalog. Both were checked before this migration was written, by grep and
-- against the catalog, rather than assumed.
--
-- daml_template_id only ever held the constant string
-- 'Insurance.PolicyToken:PolicyToken'. That is not the string the ledger is
-- addressed with: PV34 needs the raw package-id hash, so damlClient.js
-- builds `<DAML_PACKAGE_ID>:Insurance.PolicyToken:PolicyToken` at call time.
-- The column could not have served that purpose even had something read it.
--
-- daml_policy_key held "<insurer canton party id>:<policy id>", named after
-- a Daml contract key this deployment does not have -- contract keys need
-- Daml-LF 2.3 / PV35 and this network is PV34. policy_id remains the stable
-- identity and policy_status_history remains the supersession chain, which
-- is what actually links a re-minted token to its predecessor.
--
-- Checked before writing this: `policies` holds 0 rows in the working
-- database, both columns are NULL in every row that could have held one,
-- and no catalog object depends on either. No historical value is lost.

ALTER TABLE policies
  DROP COLUMN daml_template_id,
  DROP COLUMN daml_policy_key;
