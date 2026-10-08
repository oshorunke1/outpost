-- A player row per Roblox UserId the game server has reported. BIGINT UNSIGNED holds every
-- Roblox UserId, and JSON numbers carry them exactly up to 2^53 - 1.
CREATE TABLE players (
  roblox_user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  last_left_at DATETIME(3) NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Ledger accounts. Each player has one; system:mint is where earned Coins come from and
-- system:sink is where spent Coins go. Account ids compare as raw bytes (utf8mb4_bin).
CREATE TABLE accounts (
  account_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  kind ENUM('player', 'system') NOT NULL,
  roblox_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_accounts_player (roblox_user_id),
  CONSTRAINT fk_accounts_player FOREIGN KEY (roblox_user_id) REFERENCES players (roblox_user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Materialized balances for player accounts only. System balances are SUM(ledger_entries), so no
-- single hot row serializes every earn and purchase (ADR 0008). Money is whole Coins in BIGINT.
CREATE TABLE account_balances (
  account_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_balances_account FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  CONSTRAINT chk_balance_not_negative CHECK (balance >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

INSERT INTO accounts (account_id, kind, roblox_user_id, created_at) VALUES
  ('system:mint', 'system', NULL, UTC_TIMESTAMP(3)),
  ('system:sink', 'system', NULL, UTC_TIMESTAMP(3));
