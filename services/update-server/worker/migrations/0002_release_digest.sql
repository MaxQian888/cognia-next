-- ADR-0224 A10: the pinned package of a release that installs itself.
--
-- An always-on host's release is an archive (its sha256) or a Compose image
-- (its `sha256:` manifest digest). The signed catalog is what a host trusts;
-- this copy lets the rollout endpoint name the digest it is answering for,
-- so a host can match the live answer to the exact catalog entry.
ALTER TABLE releases ADD COLUMN digest TEXT;
