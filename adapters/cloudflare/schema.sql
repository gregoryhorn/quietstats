-- Reference for the single SQLite DO schema, initialized by AuthorityStore.
-- No D1 database, external migration command or distributed transaction is used.
CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aggregates(day TEXT NOT NULL,family TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(day,family));
CREATE TABLE IF NOT EXISTS restore_candidate(day TEXT PRIMARY KEY,envelope TEXT NOT NULL);
